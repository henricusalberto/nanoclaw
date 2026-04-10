/**
 * Candidate-processor — drains `entity-candidates.jsonl` nightly during
 * the dream cycle. Two-stage pipeline so the user only sees genuinely
 * ambiguous items:
 *
 *   Stage 1 — deterministic rules (free, ~1s for 1000 candidates)
 *     • Dedupe spelling variants via trigram similarity
 *     • Apply entity-name blocklist (code identifiers, AI self-refs, etc.)
 *     • Auto-merge candidates whose canonical name already has a page
 *     • Auto-promote names mentioned in ≥2 distinct source windows
 *       where the resolver routes confidently (≥0.5)
 *     • Save distinct original-thinking quotes as immutable files
 *
 *   Stage 2 — Sonnet-batched judgment (dream-budget Tier 2)
 *     • Everything Stage 1 couldn't decide gets batched 20-at-a-time
 *       to Sonnet with the candidate + source snippet + list of
 *       existing matching pages, and asked: promote / merge:<page> /
 *       discard / ask-user
 *     • Only `ask-user` outputs end up in the review queue
 *
 * The review queue (`.openclaw-wiki/review-queue.jsonl`) is consumed by
 * the `wiki-review-morning` cron, which wakes Janus at 07:30 CET to
 * surface the residue as a single structured Telegram question.
 */

import fs from 'fs';
import path from 'path';

import {
  checkDreamBudget,
  DEFAULT_DREAM_BUDGET_CONFIG,
  DreamBudgetConfig,
  markDreamBlocked,
  recordDreamSpend,
} from './dream-budget.js';
import {
  readCandidates,
  rewriteCandidates,
  EntityCandidate,
} from './entity-scan.js';
import { callClaudeCli } from './extractors/claude-cli.js';
import { atomicWriteFile } from './fs-util.js';
import { logger } from '../logger.js';
import {
  getPageTitle,
  WikiClaim,
  WikiPageFrontmatter,
  writeWikiPage,
} from './markdown.js';
import { vaultPaths } from './paths.js';
import { resolveForVault } from './resolver.js';
import { resolveSlug } from './slug-resolver.js';
import { TIER_USD_ESTIMATE } from './tier.js';
import { collectVaultPages, VaultPageRecord } from './vault-walk.js';

const BLOCKLIST = new Set([
  // AI self-references
  'janus',
  'claude',
  'claude code',
  // Code identifiers
  'lossless-claw',
  'kimbehnke',
  'mdat',
  'nanoclaw',
  'openclaw',
  // Too generic — need context to be useful
  'meta',
  'google',
  'shopify',
]);

const MIN_MENTIONS_FOR_PROMOTE = 2;

export interface ReviewQueueEntry {
  /** Canonical (deduped) name. */
  name: string;
  /** Kind proposed by the resolver (person/company/project/...). */
  proposedKind: string;
  /** Resolver target directory if the user says "promote". */
  proposedDir: string;
  /** Existing pages this might merge into (basenames). */
  mergeCandidates: string[];
  /** Short quote snippets from source windows — context for the user. */
  snippets: string[];
  /** Source window ids where this name appeared. */
  sourceWindowIds: string[];
  /** Reason we're asking instead of deciding — rule-miss or LLM-ambiguous. */
  reason: 'rule-miss' | 'llm-ambiguous';
  /** LLM rationale, when reason === 'llm-ambiguous'. */
  llmNote?: string;
}

export interface ProcessCandidatesResult {
  candidatesScanned: number;
  /** Stage 1 outcomes */
  blocked: number;
  merged: number;
  promoted: number;
  originalsSaved: number;
  /** Stage 2 outcomes */
  llmMerged: number;
  llmPromoted: number;
  llmDiscarded: number;
  llmCalls: number;
  llmBudgetBlocked: number;
  /** Final */
  reviewQueueSize: number;
  durationMs: number;
}

export interface ProcessCandidatesOptions {
  budget?: DreamBudgetConfig;
  now?: Date;
  /** Hard ceiling on Sonnet calls per run — runaway protection. */
  maxLlmCalls?: number;
  /** Test injection: override the Sonnet call. */
  stage2Call?: typeof batchedSonnetDecide;
}

// =============================================================================
// Public entry point
// =============================================================================

export async function processCandidates(
  vaultPath: string,
  opts: ProcessCandidatesOptions = {},
): Promise<ProcessCandidatesResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? DEFAULT_DREAM_BUDGET_CONFIG;
  const maxLlmCalls = opts.maxLlmCalls ?? 50;
  const stage2 = opts.stage2Call ?? batchedSonnetDecide;

  const result: ProcessCandidatesResult = {
    candidatesScanned: 0,
    blocked: 0,
    merged: 0,
    promoted: 0,
    originalsSaved: 0,
    llmMerged: 0,
    llmPromoted: 0,
    llmDiscarded: 0,
    llmCalls: 0,
    llmBudgetBlocked: 0,
    reviewQueueSize: 0,
    durationMs: 0,
  };

  const candidates = readCandidates(vaultPath);
  result.candidatesScanned = candidates.length;
  if (candidates.length === 0) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  const pages = collectVaultPages(vaultPath);
  const pagesByBasename = new Map<string, VaultPageRecord>();
  for (const p of pages) pagesByBasename.set(p.basename, p);

  // Split originals from entities; originals have their own simpler path.
  const entityRows = candidates.filter((c) => c.kind === 'entity-candidate');
  const originalRows = candidates.filter((c) => c.kind === 'original-thinking');

  // ---- STAGE 1: deterministic rules ----
  const { residue, processed } = applyStage1Rules(
    vaultPath,
    entityRows,
    pages,
    pagesByBasename,
  );
  result.blocked += processed.blocked;
  result.merged += processed.merged;
  result.promoted += processed.promoted;

  // Originals: dedupe by exact quote, save each to originals/.
  result.originalsSaved = saveOriginals(vaultPath, originalRows);

  // ---- STAGE 2: Sonnet batched judgment on residue ----
  const reviewQueue: ReviewQueueEntry[] = [];
  if (residue.length > 0) {
    const stage2Result = await runStage2(vaultPath, residue, pages, {
      budget,
      now,
      maxLlmCalls,
      stage2,
    });
    result.llmCalls = stage2Result.calls;
    result.llmBudgetBlocked = stage2Result.budgetBlocked;
    result.llmMerged = stage2Result.merged;
    result.llmPromoted = stage2Result.promoted;
    result.llmDiscarded = stage2Result.discarded;
    reviewQueue.push(...stage2Result.askUser);
  }

  // Rewrite review queue + clear the candidates file (everything has
  // been processed or moved to review).
  writeReviewQueue(vaultPath, reviewQueue);
  result.reviewQueueSize = reviewQueue.length;
  rewriteCandidates(vaultPath, []);

  result.durationMs = Date.now() - startedAt;
  return result;
}

// =============================================================================
// Stage 1 — deterministic rules
// =============================================================================

interface Stage1Output {
  residue: CandidateGroup[];
  processed: { blocked: number; merged: number; promoted: number };
}

interface CandidateGroup {
  /** Canonical display name, chosen from the longest-seen variant. */
  name: string;
  /** Sub-type declared by the LLM (person/company/tool/...). */
  entityType: string;
  /** All the distinct quotes seen for this group. */
  quotes: string[];
  /** Source windows this group came from. */
  sourceWindowIds: string[];
  /** Count of distinct mentions (one per row). */
  mentions: number;
}

function applyStage1Rules(
  vaultPath: string,
  entityRows: EntityCandidate[],
  pages: VaultPageRecord[],
  pagesByBasename: Map<string, VaultPageRecord>,
): Stage1Output {
  const groups = groupByCanonicalName(entityRows);
  const residue: CandidateGroup[] = [];
  const processed = { blocked: 0, merged: 0, promoted: 0 };

  // Build a resolver input for fuzzy matching against existing page
  // basenames + titles. Reused across all groups in this pass.
  const resolverPages = pages.map((p) => ({
    basename: p.basename,
    title:
      typeof p.frontmatter.title === 'string' ? p.frontmatter.title : undefined,
  }));

  for (const group of groups) {
    const lower = group.name.toLowerCase();

    // Rule A: blocklist
    if (BLOCKLIST.has(lower) || BLOCKLIST.has(lower.replace(/\s+/g, '-'))) {
      processed.blocked += group.mentions;
      continue;
    }

    // Rule B: match an existing page by basename (exact or fuzzy)
    const slugCandidates = resolveSlug(group.name, resolverPages, {
      limit: 1,
      minScore: 0.6,
    });
    const match = slugCandidates[0];
    if (match) {
      const page = pagesByBasename.get(match.basename);
      if (page) {
        appendClaimsToPage(vaultPath, page, group);
        processed.merged += group.mentions;
        continue;
      }
    }

    // Rule C: promote new entity if it meets the mention threshold AND
    // the resolver routes it confidently.
    if (group.mentions >= MIN_MENTIONS_FOR_PROMOTE) {
      const decision = resolveForVault(vaultPath, {
        title: group.name,
        // Map the LLM entity type onto a resolver hint.
        pageType: mapEntityTypeToKind(group.entityType),
      });
      if (decision.confidence >= 0.5) {
        createStubPage(vaultPath, group, decision.directory, decision.kind);
        processed.promoted += group.mentions;
        continue;
      }
    }

    // Everything else → residue for Stage 2.
    residue.push(group);
  }

  return { residue, processed };
}

function groupByCanonicalName(rows: EntityCandidate[]): CandidateGroup[] {
  // Two-pass: first normalise every name, then merge buckets whose
  // normalised forms match. Fuzzy merges (Dom / Dominic Ingleston)
  // happen via a second sweep with trigram similarity.
  const byNorm = new Map<string, CandidateGroup>();
  for (const row of rows) {
    if (!row.name) continue;
    const key = row.name.toLowerCase().trim();
    const existing = byNorm.get(key);
    if (existing) {
      existing.mentions++;
      if (row.quote && !existing.quotes.includes(row.quote)) {
        existing.quotes.push(row.quote);
      }
      const wid = row.window?.windowId;
      if (wid && !existing.sourceWindowIds.includes(wid)) {
        existing.sourceWindowIds.push(wid);
      }
      if (row.name.length > existing.name.length) existing.name = row.name;
    } else {
      byNorm.set(key, {
        name: row.name,
        entityType: row.entityType ?? 'unknown',
        quotes: row.quote ? [row.quote] : [],
        sourceWindowIds: row.window?.windowId ? [row.window.windowId] : [],
        mentions: 1,
      });
    }
  }

  // Fuzzy merge: collapse groups whose trigram similarity ≥ 0.7 into
  // the one with the most mentions. This catches "Dom" / "Dominic
  // Ingleston" / "Domonic Ingleston" → single bucket.
  const groups = Array.from(byNorm.values()).sort(
    (a, b) => b.mentions - a.mentions,
  );
  const merged: CandidateGroup[] = [];
  const eaten = new Set<string>();
  const resolverInput = groups.map((g) => ({ basename: g.name }));
  for (const g of groups) {
    if (eaten.has(g.name)) continue;
    const matches = resolveSlug(g.name, resolverInput, {
      limit: 20,
      minScore: 0.7,
    });
    for (const m of matches) {
      if (m.basename === g.name) continue;
      const other = groups.find((x) => x.name === m.basename);
      if (!other || eaten.has(other.name)) continue;
      g.mentions += other.mentions;
      for (const q of other.quotes) {
        if (!g.quotes.includes(q)) g.quotes.push(q);
      }
      for (const wid of other.sourceWindowIds) {
        if (!g.sourceWindowIds.includes(wid)) g.sourceWindowIds.push(wid);
      }
      eaten.add(other.name);
    }
    merged.push(g);
  }
  return merged;
}

function mapEntityTypeToKind(entityType: string): string | undefined {
  const map: Record<string, string> = {
    person: 'person',
    company: 'company',
    product: 'project',
    tool: 'concept',
    concept: 'concept',
  };
  return map[entityType];
}

/**
 * Map candidate window ids back to the bridge source pages they came
 * from so new/updated pages get proper `sourceIds[]` citations in
 * frontmatter. Backfill windows are named `backfill:<basename>` which
 * corresponds to the source page id `source.<basename>`. Live entity-
 * scan windows (from Telegram conversation batching) don't map to a
 * bridge source page and are left out.
 */
function deriveSourceIdsFromWindows(windowIds: string[]): string[] {
  const ids = new Set<string>();
  for (const wid of windowIds) {
    if (wid.startsWith('backfill:')) {
      ids.add(`source.${wid.slice('backfill:'.length)}`);
    }
  }
  return Array.from(ids);
}

function appendClaimsToPage(
  vaultPath: string,
  page: VaultPageRecord,
  group: CandidateGroup,
): void {
  const existing = Array.isArray(page.frontmatter.claims)
    ? (page.frontmatter.claims as WikiClaim[])
    : [];
  const ts = new Date().toISOString();
  const datePart = ts.slice(0, 10);
  const newClaims: WikiClaim[] = group.quotes.slice(0, 3).map((q, i) => ({
    id: `${page.basename}.auto-${datePart}-${i}`,
    text: q,
    status: 'supported',
    confidence: 0.6,
    evidence: [
      {
        note: `[Source: entity-scan, ${group.sourceWindowIds[0] ?? 'unknown'}, ${datePart}]`,
        updatedAt: ts,
      },
    ],
    updatedAt: ts,
  }));
  // Merge new source-id citations into whatever the page already has.
  const existingSourceIds = new Set(
    Array.isArray(page.frontmatter.sourceIds)
      ? (page.frontmatter.sourceIds as string[])
      : [],
  );
  for (const id of deriveSourceIdsFromWindows(group.sourceWindowIds)) {
    existingSourceIds.add(id);
  }
  const updatedFm: WikiPageFrontmatter = {
    ...page.frontmatter,
    sourceIds: Array.from(existingSourceIds),
    claims: [...existing, ...newClaims],
    updatedAt: ts,
  };
  writeWikiPage(page.filePath, updatedFm, page.body, {
    writtenBy: 'candidate-processor',
    reason: `merge ${group.mentions} mentions of ${group.name}`,
    skipSnapshot: true,
  });
}

function createStubPage(
  vaultPath: string,
  group: CandidateGroup,
  directory: string,
  kind: string,
): void {
  const basename = group.name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
  const filePath = path.join(vaultPath, directory, `${basename}.md`);
  if (fs.existsSync(filePath)) return; // race-safety: don't overwrite
  const ts = new Date().toISOString();
  const datePart = ts.slice(0, 10);
  const body = [
    `# ${group.name}`,
    '',
    `_Auto-created by candidate-processor on ${datePart}. ${group.mentions} mentions across ${group.sourceWindowIds.length} source windows. Review and expand._`,
    '',
    '## Observed mentions',
    '',
    ...group.quotes.slice(0, 5).map((q) => `- "${q}"`),
    '',
    '## Notes',
    '',
    '<!-- openclaw:human:start -->',
    '',
    '<!-- openclaw:human:end -->',
    '',
  ].join('\n');
  writeWikiPage(
    filePath,
    {
      id: `${kind}.${basename}`,
      pageType: kind as never,
      title: group.name,
      sourceIds: deriveSourceIdsFromWindows(group.sourceWindowIds),
      claims: group.quotes.slice(0, 3).map((q, i) => ({
        id: `${basename}.auto-${datePart}-${i}`,
        text: q,
        status: 'supported',
        confidence: 0.6,
        evidence: [
          {
            note: `[Source: entity-scan, ${group.sourceWindowIds[0] ?? 'unknown'}, ${datePart}]`,
            updatedAt: ts,
          },
        ],
        updatedAt: ts,
      })),
      contradictions: [],
      questions: [],
      confidence: 0.5,
      status: 'active',
      updatedAt: ts,
    },
    body,
    {
      writtenBy: 'candidate-processor',
      reason: `auto-promote from ${group.mentions} mentions`,
    },
  );
}

function saveOriginals(vaultPath: string, rows: EntityCandidate[]): number {
  const originalsDir = path.join(vaultPath, 'originals');
  fs.mkdirSync(originalsDir, { recursive: true });

  const seen = new Set<string>();
  let saved = 0;
  for (const row of rows) {
    const quote = row.quote?.trim();
    if (!quote || quote.length < 10) continue;
    if (seen.has(quote)) continue;
    seen.add(quote);

    const ts = new Date().toISOString();
    const datePart = ts.slice(0, 10);
    const slug = quote
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 6)
      .join('-')
      .replace(/[^\w-]/g, '')
      .slice(0, 60);
    const filename = `${datePart}--${slug}.md`;
    const filePath = path.join(originalsDir, filename);
    if (fs.existsSync(filePath)) continue;

    const windowId = row.window?.windowId;
    const sourceIds = windowId ? deriveSourceIdsFromWindows([windowId]) : [];
    writeWikiPage(
      filePath,
      {
        id: `original.${datePart}-${slug}`,
        pageType: 'original',
        title: quote.slice(0, 60),
        sourceIds,
        claims: [],
        contradictions: [],
        questions: [],
        confidence: 1,
        status: 'active',
        updatedAt: ts,
        verbatim: true,
        sourceWindowId: row.window?.windowId,
      } as WikiPageFrontmatter,
      `> ${quote}\n\n_Verbatim thought, do not rewrite. Source window: ${row.window?.windowId ?? 'unknown'}._\n`,
      {
        writtenBy: 'candidate-processor',
        reason: 'save original-thinking quote',
      },
    );
    saved++;
  }
  return saved;
}

// =============================================================================
// Stage 2 — Sonnet batched judgment
// =============================================================================

interface Stage2Output {
  merged: number;
  promoted: number;
  discarded: number;
  askUser: ReviewQueueEntry[];
  calls: number;
  budgetBlocked: number;
}

interface Stage2RunOptions {
  budget: DreamBudgetConfig;
  now: Date;
  maxLlmCalls: number;
  stage2: typeof batchedSonnetDecide;
}

async function runStage2(
  vaultPath: string,
  residue: CandidateGroup[],
  pages: VaultPageRecord[],
  opts: Stage2RunOptions,
): Promise<Stage2Output> {
  const out: Stage2Output = {
    merged: 0,
    promoted: 0,
    discarded: 0,
    askUser: [],
    calls: 0,
    budgetBlocked: 0,
  };

  const BATCH = 20;
  const pagesByBasename = new Map<string, VaultPageRecord>();
  for (const p of pages) pagesByBasename.set(p.basename, p);

  for (let i = 0; i < residue.length; i += BATCH) {
    if (out.calls >= opts.maxLlmCalls) break;

    const check = checkDreamBudget(vaultPath, 2, opts.budget, opts.now);
    if (!check.allowed) {
      out.budgetBlocked++;
      markDreamBlocked(
        vaultPath,
        check.reason ?? 'dream budget exhausted',
        check.state,
      );
      // Everything from here gets pushed to the review queue.
      for (const g of residue.slice(i)) {
        out.askUser.push(groupToReviewEntry(g, 'rule-miss'));
      }
      break;
    }

    const batch = residue.slice(i, i + BATCH);
    let decisions: Stage2Decision[];
    try {
      decisions = await opts.stage2(batch, pages);
    } catch (err) {
      logger.warn(
        { err: String(err) },
        'candidate-processor: Stage 2 LLM call failed, escalating batch to user',
      );
      for (const g of batch)
        out.askUser.push(groupToReviewEntry(g, 'rule-miss'));
      continue;
    }

    recordDreamSpend(
      vaultPath,
      2,
      TIER_USD_ESTIMATE[2],
      check.state,
      opts.now,
      opts.budget.tz,
    );
    out.calls++;

    for (let j = 0; j < batch.length; j++) {
      const group = batch[j];
      const decision = decisions[j] ?? {
        action: 'ask-user',
        note: 'no decision returned',
      };
      switch (decision.action) {
        case 'merge': {
          const page = decision.target && pagesByBasename.get(decision.target);
          if (page) {
            appendClaimsToPage(vaultPath, page, group);
            out.merged++;
          } else {
            out.askUser.push(
              groupToReviewEntry(group, 'llm-ambiguous', decision.note),
            );
          }
          break;
        }
        case 'promote': {
          const resolverDecision = resolveForVault(vaultPath, {
            title: group.name,
            pageType: mapEntityTypeToKind(group.entityType),
          });
          createStubPage(
            vaultPath,
            group,
            resolverDecision.directory,
            resolverDecision.kind,
          );
          out.promoted++;
          break;
        }
        case 'discard':
          out.discarded++;
          break;
        case 'ask-user':
        default:
          out.askUser.push(
            groupToReviewEntry(group, 'llm-ambiguous', decision.note),
          );
      }
    }
  }

  return out;
}

interface Stage2Decision {
  action: 'merge' | 'promote' | 'discard' | 'ask-user';
  target?: string; // basename when action === 'merge'
  note?: string;
}

export async function batchedSonnetDecide(
  batch: CandidateGroup[],
  pages: VaultPageRecord[],
): Promise<Stage2Decision[]> {
  const pageList = pages
    .filter((p) => {
      return (
        p.kind === 'person' ||
        p.kind === 'company' ||
        p.kind === 'project' ||
        p.kind === 'concept' ||
        p.kind === 'entity'
      );
    })
    .map((p) => {
      const title = getPageTitle(p.frontmatter, p.basename);
      return `- ${p.basename} (${p.kind ?? 'unknown'}): ${title}`;
    })
    .join('\n');

  const candidatesJson = JSON.stringify(
    batch.map((g, i) => ({
      idx: i,
      name: g.name,
      entityType: g.entityType,
      mentions: g.mentions,
      sampleQuotes: g.quotes.slice(0, 2),
    })),
    null,
    2,
  );

  const prompt = `You are curating candidate entities for a personal wiki. For each candidate below, decide ONE action:
- "merge": the candidate refers to an existing page; specify which via target=<basename>
- "promote": create a new stub page for this entity
- "discard": this is noise (AI self-reference, code identifier, too generic, not a real entity)
- "ask-user": genuinely ambiguous; you cannot decide without the user's context

Return a JSON array with one object per candidate, same order as input. Each object:
{"idx": <candidate index>, "action": "merge"|"promote"|"discard"|"ask-user", "target": "<basename if merge>", "note": "<short reason>"}

Rules:
- Prefer "merge" over "promote" when there's ANY reasonable match in the existing-pages list
- Prefer "discard" for obvious noise — don't escalate to user for clearly non-entity names
- Only use "ask-user" for TRULY ambiguous cases (e.g., a name that could be a person or a company)
- Route "promote" to whichever MECE dir the entity naturally belongs in; don't worry about directory in the output

EXISTING PAGES (basename: kind: title):
${pageList}

CANDIDATES:
${candidatesJson}

Return ONLY the JSON array. No prose.`;

  const { json } = await callClaudeCli({
    prompt,
    model: 'claude-sonnet-4-5',
    timeoutMs: 120_000,
  });

  if (!Array.isArray(json)) {
    // Degrade gracefully — escalate the whole batch.
    return batch.map(() => ({
      action: 'ask-user' as const,
      note: 'LLM returned non-array',
    }));
  }

  const result: Stage2Decision[] = [];
  for (let i = 0; i < batch.length; i++) {
    const row = (json as Array<Record<string, unknown>>).find(
      (r) => r && typeof r === 'object' && r.idx === i,
    );
    if (!row) {
      result.push({ action: 'ask-user', note: 'missing in LLM response' });
      continue;
    }
    const action = row.action;
    if (
      action === 'merge' ||
      action === 'promote' ||
      action === 'discard' ||
      action === 'ask-user'
    ) {
      result.push({
        action,
        target: typeof row.target === 'string' ? row.target : undefined,
        note: typeof row.note === 'string' ? row.note : undefined,
      });
    } else {
      result.push({ action: 'ask-user', note: 'invalid action from LLM' });
    }
  }
  return result;
}

// =============================================================================
// Review queue persistence
// =============================================================================

function reviewQueuePath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'review-queue.jsonl');
}

export function readReviewQueue(vaultPath: string): ReviewQueueEntry[] {
  const file = reviewQueuePath(vaultPath);
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const out: ReviewQueueEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ReviewQueueEntry);
      } catch {
        // skip torn line
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeReviewQueue(
  vaultPath: string,
  entries: ReviewQueueEntry[],
): void {
  const file = reviewQueuePath(vaultPath);
  const content =
    entries.length > 0
      ? entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : '';
  atomicWriteFile(file, content);
}

function groupToReviewEntry(
  group: CandidateGroup,
  reason: 'rule-miss' | 'llm-ambiguous',
  llmNote?: string,
): ReviewQueueEntry {
  return {
    name: group.name,
    proposedKind: mapEntityTypeToKind(group.entityType) ?? 'inbox-item',
    proposedDir: '',
    mergeCandidates: [],
    snippets: group.quotes.slice(0, 3),
    sourceWindowIds: group.sourceWindowIds,
    reason,
    ...(llmNote && { llmNote }),
  };
}
