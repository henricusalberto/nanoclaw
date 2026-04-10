/**
 * Conversation-window entity scanner.
 *
 * Reads `entity-queue.jsonl` rows enqueued by container-runner, groups
 * them into closed conversation windows (60s idle OR 10-msg hard-flush),
 * applies a deterministic pre-filter to drop noise, and dispatches
 * surviving windows to a Haiku-class LLM for entity + original-thinking
 * extraction. Validated candidates are appended to
 * `entity-candidates.jsonl` so the Janus wiki skill can pick them up on
 * the next container spawn.
 *
 * Budget + quiet-hours gates live in scan-budget.ts and quiet-hours.ts.
 * This module orchestrates — it never spends money without first asking
 * the budget ledger, and it never makes LLM calls during quiet hours.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import {
  DEFAULT_ENTITY_SCAN_CONFIG,
  EntityScanConfig,
  readBridgeConfig,
} from './bridge-config.js';
import { compactQueue, EntityQueueRow, readQueue } from './entity-queue.js';
import { callClaudeCli } from './extractors/claude-cli.js';
import { atomicWriteFile } from './fs-util.js';
import { appendWikiLogEvent } from './log.js';
import { vaultPaths } from './paths.js';
import { isQuietHour } from './quiet-hours.js';
import {
  checkBudget,
  estimateUsd,
  markBlocked,
  recordSpend,
} from './scan-budget.js';

// =============================================================================
// Types
// =============================================================================

export interface ConversationWindow {
  windowId: string;
  groupFolder: string;
  chatJid: string;
  openedAt: string;
  closedAt: string;
  rows: EntityQueueRow[];
  text: string;
}

export interface EntityCandidate {
  kind: 'entity-candidate' | 'original-thinking';
  name: string;
  entityType?: string;
  quote: string;
  window: {
    windowId: string;
    groupFolder: string;
    openedAt: string;
    closedAt: string;
  };
  extractedAt: string;
}

export interface LlmExtractionResult {
  entities: Array<{ name: string; type: string; quote: string }>;
  originals: Array<{ quote: string }>;
  skipReason?: string;
}

export interface LlmAdapter {
  extract(windowText: string): Promise<LlmExtractionResult>;
}

export interface EntityScanResult {
  vaultPath: string;
  windowsProcessed: number;
  windowsRejectedByPrefilter: number;
  windowsSkippedQuietHours: number;
  windowsSkippedBudget: number;
  entitiesExtracted: number;
  originalsExtracted: number;
  llmCalls: number;
  usdSpent: number;
  durationMs: number;
}

// =============================================================================
// Window grouping
// =============================================================================

/**
 * Group a sorted row list into conversation windows. A window closes when
 * either condition holds:
 *   - gap from prior row > idleSeconds
 *   - window length reaches maxMessages
 *
 * The final window is "open" unless the last row is older than `now -
 * idleSeconds`, in which case it's also considered closed.
 */
export function groupRowsIntoWindows(
  rows: EntityQueueRow[],
  idleSeconds: number,
  maxMessages: number,
  now: Date,
): { closed: ConversationWindow[]; open: EntityQueueRow[] } {
  if (rows.length === 0) return { closed: [], open: [] };
  const sorted = [...rows].sort((a, b) => a.ts.localeCompare(b.ts));

  // Group by (groupFolder, chatJid) first — conversations across chats
  // don't batch together.
  const byChat = new Map<string, EntityQueueRow[]>();
  for (const r of sorted) {
    const key = `${r.groupFolder}::${r.chatJid}`;
    const arr = byChat.get(key) ?? [];
    arr.push(r);
    byChat.set(key, arr);
  }

  const closed: ConversationWindow[] = [];
  const open: EntityQueueRow[] = [];
  const idleMs = idleSeconds * 1000;
  const nowMs = now.getTime();

  for (const [, chatRows] of byChat) {
    let current: EntityQueueRow[] = [];
    const flush = (force: boolean) => {
      if (current.length === 0) return;
      const lastTs = Date.parse(current[current.length - 1].ts);
      const isIdle = nowMs - lastTs > idleMs;
      if (force || isIdle || current.length >= maxMessages) {
        closed.push(buildWindow(current));
        current = [];
      }
    };

    for (const r of chatRows) {
      if (current.length === 0) {
        current.push(r);
        continue;
      }
      const prevTs = Date.parse(current[current.length - 1].ts);
      const gap = Date.parse(r.ts) - prevTs;
      if (gap > idleMs || current.length >= maxMessages) {
        // Previous window closes before this row joins a new one.
        closed.push(buildWindow(current));
        current = [r];
      } else {
        current.push(r);
      }
    }

    flush(false);
    // Anything still in `current` after flush is genuinely open.
    open.push(...current);
  }

  return { closed, open };
}

function buildWindow(rows: EntityQueueRow[]): ConversationWindow {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const windowId = `${first.groupFolder}-${Date.parse(first.ts)}-${rows.length}`;
  return {
    windowId,
    groupFolder: first.groupFolder,
    chatJid: first.chatJid,
    openedAt: first.ts,
    closedAt: last.ts,
    rows,
    text: rows.map((r) => `${r.sender}: ${r.snippet}`).join('\n'),
  };
}

// =============================================================================
// Pre-filter (deterministic, no LLM)
// =============================================================================

const STOPWORD_ONLY_RE =
  /^[\s\p{P}\d]*$|^(ok|yes|no|lol|thx|thanks|k|sure|hi|hey|bye|\+1|\?+|!+)$/iu;

/**
 * Returns true if the window is rich enough to merit an LLM call. False
 * means reject — save the money.
 */
export function prefilterWindow(window: ConversationWindow): {
  accept: boolean;
  reason?: string;
} {
  const text = window.text.trim();
  if (text.length < 80) return { accept: false, reason: 'too-short' };

  // Count capitalized tokens (proper nouns, products, names). If zero,
  // it's probably small talk.
  const capitalized = text.match(/\b[A-Z][a-zA-Z0-9]{2,}/g) ?? [];
  if (capitalized.length === 0) {
    return { accept: false, reason: 'no-capitalized-tokens' };
  }

  // Collapse to just the user messages joined
  const userText = window.rows
    .map((r) => r.snippet.trim())
    .filter(Boolean)
    .join(' ');
  if (STOPWORD_ONLY_RE.test(userText)) {
    return { accept: false, reason: 'stopword-only' };
  }

  return { accept: true };
}

// =============================================================================
// Claude CLI LLM adapter
// =============================================================================

const ENTITY_EXTRACTION_PROMPT = `You are an entity and original-thinking extractor for a personal second-brain wiki.

From the conversation below, extract:
1. ENTITIES: named people, companies, products, tools, places, concepts that appear to be consequential — worth a wiki page. Skip generic nouns, small talk, numbers, dates.
2. ORIGINAL THINKING: verbatim quotes where the speaker expresses a distinctive belief, framework, prediction, or opinion (not reporting facts). Must be word-for-word from the input.

Rules:
- Every extracted entity's "quote" must literally appear in the input text.
- If the conversation is pure small talk, scheduling, logistics, or acknowledgement, return {"entities":[],"originals":[],"skipReason":"noise"}.
- Maximum 5 entities and 3 originals per response.

Respond with ONLY a JSON object of this exact shape (no prose, no markdown):
{"entities":[{"name":"string","type":"person|company|product|tool|place|concept","quote":"exact substring"}],"originals":[{"quote":"exact substring"}],"skipReason":"optional string"}

Conversation:
`;

const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['name', 'type', 'quote'],
      },
    },
    originals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { quote: { type: 'string' } },
        required: ['quote'],
      },
    },
    skipReason: { type: 'string' },
  },
  required: ['entities', 'originals'],
};

/**
 * Default LLM adapter. Delegates to the shared `callClaudeCli` helper
 * so the argv + timeout + error shape lives in one place. Any failure
 * (timeout, non-zero exit, unparseable stdout) collapses to an empty
 * extraction — entity-scan never retries.
 */
export class ClaudeCliAdapter implements LlmAdapter {
  constructor(
    private readonly model: string = 'claude-haiku-4-5',
    private readonly timeoutMs: number = 60_000,
  ) {}

  async extract(windowText: string): Promise<LlmExtractionResult> {
    try {
      const { json } = await callClaudeCli({
        prompt: ENTITY_EXTRACTION_PROMPT + windowText,
        model: this.model,
        timeoutMs: this.timeoutMs,
        jsonSchema: EXTRACTION_JSON_SCHEMA,
      });
      const parsed = (json ?? {}) as LlmExtractionResult;
      return {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        originals: Array.isArray(parsed.originals) ? parsed.originals : [],
        ...(parsed.skipReason && { skipReason: parsed.skipReason }),
      };
    } catch (err) {
      logger.warn({ err: String(err) }, 'entity-scan: claude CLI call failed');
      return { entities: [], originals: [] };
    }
  }
}

// =============================================================================
// Validation: LLM output must literally quote the input
// =============================================================================

function validateExtraction(
  result: LlmExtractionResult,
  windowText: string,
): LlmExtractionResult {
  const text = windowText;
  const entities = result.entities.filter(
    (e) =>
      typeof e.name === 'string' &&
      typeof e.quote === 'string' &&
      e.quote.length > 0 &&
      text.includes(e.quote),
  );
  const originals = result.originals.filter(
    (o) =>
      typeof o.quote === 'string' &&
      o.quote.length > 0 &&
      text.includes(o.quote),
  );
  return {
    entities,
    originals,
    ...(result.skipReason && { skipReason: result.skipReason }),
  };
}

// =============================================================================
// Candidate persistence
// =============================================================================

function candidatesPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'entity-candidates.jsonl');
}

export function appendCandidates(
  vaultPath: string,
  candidates: EntityCandidate[],
): void {
  if (candidates.length === 0) return;
  const file = candidatesPath(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = candidates.map((c) => JSON.stringify(c)).join('\n') + '\n';
  fs.appendFileSync(file, lines);
}

export function readCandidates(vaultPath: string): EntityCandidate[] {
  const file = candidatesPath(vaultPath);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const out: EntityCandidate[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EntityCandidate);
    } catch {
      // skip torn lines
    }
  }
  return out;
}

/** Rewrite the candidates file, useful for Janus marking rows processed. */
export function rewriteCandidates(
  vaultPath: string,
  candidates: EntityCandidate[],
): void {
  const file = candidatesPath(vaultPath);
  const content =
    candidates.length > 0
      ? candidates.map((c) => JSON.stringify(c)).join('\n') + '\n'
      : '';
  atomicWriteFile(file, content);
}

export function getCandidatesPath(vaultPath: string): string {
  return candidatesPath(vaultPath);
}

// =============================================================================
// Main scan runner
// =============================================================================

export interface RunEntityScanOptions {
  /** Inject a stub adapter in tests. Defaults to ClaudeCliAdapter. */
  adapter?: LlmAdapter;
  /** Override the current wall clock, for deterministic tests. */
  now?: Date;
  /** Skip quiet hours check (used by the morning flush cron). */
  skipQuietHours?: boolean;
}

export async function runEntityScan(
  vaultPath: string,
  opts: RunEntityScanOptions = {},
): Promise<EntityScanResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const result: EntityScanResult = {
    vaultPath,
    windowsProcessed: 0,
    windowsRejectedByPrefilter: 0,
    windowsSkippedQuietHours: 0,
    windowsSkippedBudget: 0,
    entitiesExtracted: 0,
    originalsExtracted: 0,
    llmCalls: 0,
    usdSpent: 0,
    durationMs: 0,
  };

  const bridgeCfg = readBridgeConfig(vaultPath);
  const cfg: EntityScanConfig =
    bridgeCfg.entityScan ?? DEFAULT_ENTITY_SCAN_CONFIG;
  if (!cfg.enabled) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const rows = readQueue(vaultPath);
  const { closed, open } = groupRowsIntoWindows(
    rows,
    cfg.windowIdleSeconds,
    cfg.windowMaxMessages,
    now,
  );

  const adapter = opts.adapter ?? new ClaudeCliAdapter();
  const quietHoursActive =
    !opts.skipQuietHours &&
    isQuietHour(now, {
      tz: cfg.quietHoursTz,
      startHour: cfg.quietHoursStart,
      endHour: cfg.quietHoursEnd,
    });

  for (const window of closed) {
    const pre = prefilterWindow(window);
    if (!pre.accept) {
      result.windowsRejectedByPrefilter++;
      continue;
    }

    if (quietHoursActive) {
      result.windowsSkippedQuietHours++;
      // Leave the window's rows in the queue — morning cron will retry.
      open.push(...window.rows);
      continue;
    }

    // Estimate cost before the call.
    const approxInputTokens = Math.ceil(window.text.length / 4) + 200;
    const approxOutputTokens = 400;
    const est = estimateUsd(approxInputTokens, approxOutputTokens);
    const check = checkBudget(
      vaultPath,
      cfg.dailyBudgetUsd,
      est,
      now,
      cfg.quietHoursTz,
    );
    if (!check.allowed) {
      result.windowsSkippedBudget++;
      markBlocked(vaultPath, check.reason ?? 'budget exhausted', check.state);
      // Put the window's rows back on the open list so tomorrow picks
      // them up when the ledger resets.
      open.push(...window.rows);
      continue;
    }

    let extraction: LlmExtractionResult;
    try {
      const raw = await adapter.extract(window.text);
      extraction = validateExtraction(raw, window.text);
    } catch (err) {
      logger.warn(
        { err: String(err), windowId: window.windowId },
        'entity-scan: LLM adapter threw',
      );
      extraction = { entities: [], originals: [] };
    }

    recordSpend(vaultPath, est, check.state, now, cfg.quietHoursTz);
    result.llmCalls++;
    result.usdSpent += est;
    result.windowsProcessed++;

    const candidates: EntityCandidate[] = [];
    const extractedAt = new Date().toISOString();
    for (const e of extraction.entities) {
      candidates.push({
        kind: 'entity-candidate',
        name: e.name,
        entityType: e.type,
        quote: e.quote,
        window: {
          windowId: window.windowId,
          groupFolder: window.groupFolder,
          openedAt: window.openedAt,
          closedAt: window.closedAt,
        },
        extractedAt,
      });
    }
    for (const o of extraction.originals) {
      candidates.push({
        kind: 'original-thinking',
        name: '',
        quote: o.quote,
        window: {
          windowId: window.windowId,
          groupFolder: window.groupFolder,
          openedAt: window.openedAt,
          closedAt: window.closedAt,
        },
        extractedAt,
      });
    }
    appendCandidates(vaultPath, candidates);
    result.entitiesExtracted += extraction.entities.length;
    result.originalsExtracted += extraction.originals.length;
  }

  // Compact queue: keep only rows still "open" (not part of any closed
  // window). Windows skipped by quiet-hours or budget had their rows
  // pushed back onto `open`.
  compactQueue(vaultPath, open);

  appendWikiLogEvent(vaultPath, 'entity-scan', {
    windowsProcessed: result.windowsProcessed,
    windowsRejectedByPrefilter: result.windowsRejectedByPrefilter,
    windowsSkippedQuietHours: result.windowsSkippedQuietHours,
    windowsSkippedBudget: result.windowsSkippedBudget,
    entitiesExtracted: result.entitiesExtracted,
    originalsExtracted: result.originalsExtracted,
    usdSpent: result.usdSpent,
  });

  result.durationMs = Date.now() - startedAt;
  return result;
}

// =============================================================================
// One-shot backfill against bridged source pages
// =============================================================================

export interface BackfillSourcesOptions {
  adapter?: LlmAdapter;
  now?: Date;
  /**
   * Cap on the number of pages to process. Defaults to 200, which at
   * ~$0.003/call keeps a single backfill comfortably under the daily
   * budget. Pass `Infinity` for "process everything" — but check the
   * budget first.
   */
  maxPages?: number;
}

/**
 * Walk every bridged memory source page (daily-note, memory-root,
 * user-context — NOT bookmark/extracted-asset which already have
 * structured metadata) and run them through the same Haiku extraction
 * the live windowed scanner uses. Appends candidates to
 * entity-candidates.jsonl for Janus to curate.
 *
 * Designed for one-shot use after vault initialization or after
 * importing a backlog of memory files. Budget-gated like the live
 * scanner, but each page is its own "window" so the budget per call
 * is predictable.
 */
export async function backfillEntityScanFromSources(
  vaultPath: string,
  opts: BackfillSourcesOptions = {},
): Promise<EntityScanResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const result: EntityScanResult = {
    vaultPath,
    windowsProcessed: 0,
    windowsRejectedByPrefilter: 0,
    windowsSkippedQuietHours: 0,
    windowsSkippedBudget: 0,
    entitiesExtracted: 0,
    originalsExtracted: 0,
    llmCalls: 0,
    usdSpent: 0,
    durationMs: 0,
  };

  const bridgeCfg = readBridgeConfig(vaultPath);
  const cfg: EntityScanConfig =
    bridgeCfg.entityScan ?? DEFAULT_ENTITY_SCAN_CONFIG;
  // Backfill ignores `enabled: false` — it's an explicit one-shot
  // operation the user invokes manually, not a background cron.

  const sourcesDir = path.join(vaultPath, 'sources');
  if (!fs.existsSync(sourcesDir)) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Memory source pages have bridgeKind in this set; bookmarks and
  // future asset extractors don't.
  const MEMORY_KINDS = new Set(['daily-note', 'memory-root', 'user-context']);

  const adapter = opts.adapter ?? new ClaudeCliAdapter();
  const maxPages = opts.maxPages ?? 200;

  const candidates = fs
    .readdirSync(sourcesDir)
    .filter((f) => f.endsWith('.md') && f !== 'index.md')
    .map((f) => path.join(sourcesDir, f));

  let processed = 0;
  for (const filePath of candidates) {
    if (processed >= maxPages) break;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Quick frontmatter sniff for bridgeKind. Avoid full YAML parse
    // since the bodies are large; the line-based check is enough.
    const fmEnd = raw.indexOf('\n---', 4);
    const fm = fmEnd > 0 ? raw.slice(0, fmEnd) : '';
    const kindMatch = /^bridgeKind:\s*(\S+)/m.exec(fm);
    if (!kindMatch) continue;
    if (!MEMORY_KINDS.has(kindMatch[1])) continue;

    // Strip the bridge metadata table and the fenced ```markdown wrapper
    // to recover the original memory text. The fence is the section we
    // want to extract from.
    const fenceMatch = /```markdown\n([\s\S]*?)\n```/.exec(raw);
    const text = fenceMatch ? fenceMatch[1] : raw;

    if (text.length < 80) continue;

    // Budget pre-check.
    const approxInputTokens = Math.ceil(text.length / 4) + 200;
    const approxOutputTokens = 400;
    const est = estimateUsd(approxInputTokens, approxOutputTokens);
    const check = checkBudget(
      vaultPath,
      cfg.dailyBudgetUsd,
      est,
      now,
      cfg.quietHoursTz,
    );
    if (!check.allowed) {
      result.windowsSkippedBudget++;
      markBlocked(vaultPath, check.reason ?? 'budget exhausted', check.state);
      break; // stop the whole backfill once blocked
    }

    let extraction: LlmExtractionResult;
    try {
      const rawResult = await adapter.extract(text);
      extraction = validateExtraction(rawResult, text);
    } catch (err) {
      logger.warn(
        { err: String(err), source: path.basename(filePath) },
        'entity-scan backfill: adapter threw',
      );
      extraction = { entities: [], originals: [] };
    }

    recordSpend(vaultPath, est, check.state, now, cfg.quietHoursTz);
    result.llmCalls++;
    result.usdSpent += est;
    result.windowsProcessed++;
    processed++;

    const sourceBasename = path.basename(filePath, '.md');
    const extractedAt = new Date().toISOString();
    const out: EntityCandidate[] = [];
    for (const e of extraction.entities) {
      out.push({
        kind: 'entity-candidate',
        name: e.name,
        entityType: e.type,
        quote: e.quote,
        window: {
          windowId: `backfill:${sourceBasename}`,
          groupFolder: 'backfill-source',
          openedAt: extractedAt,
          closedAt: extractedAt,
        },
        extractedAt,
      });
    }
    for (const o of extraction.originals) {
      out.push({
        kind: 'original-thinking',
        name: '',
        quote: o.quote,
        window: {
          windowId: `backfill:${sourceBasename}`,
          groupFolder: 'backfill-source',
          openedAt: extractedAt,
          closedAt: extractedAt,
        },
        extractedAt,
      });
    }
    appendCandidates(vaultPath, out);
    result.entitiesExtracted += extraction.entities.length;
    result.originalsExtracted += extraction.originals.length;
  }

  appendWikiLogEvent(vaultPath, 'entity-scan', {
    phase: 'backfill-sources',
    pagesProcessed: result.windowsProcessed,
    entitiesExtracted: result.entitiesExtracted,
    originalsExtracted: result.originalsExtracted,
    usdSpent: result.usdSpent,
  });

  result.durationMs = Date.now() - startedAt;
  return result;
}
