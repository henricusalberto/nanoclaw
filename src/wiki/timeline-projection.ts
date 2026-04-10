/**
 * Compile-time timeline projection.
 *
 * For each entity/person/company/project/deal page, walks existing data
 * and produces a chronological `## Timeline` managed block:
 *
 *   - Source pages whose `sourceIds` reference this page (from bridge
 *     imports and manual ingests)
 *   - Claims on the page itself, sorted by `updatedAt`
 *   - Log events in `.openclaw-wiki/log.jsonl` that touch this page
 *
 * Zero write friction — the user never edits timelines by hand. This is
 * a pure projection: running compile twice on an unchanged vault
 * produces byte-identical timeline blocks.
 *
 * Every entry carries `[Source: ...]` attribution so the existing
 * `timeline-missing-attribution` lint check passes automatically.
 */

import path from 'path';

import { readWikiLogEvents } from './log.js';
import {
  getPageTitle,
  ParsedWikiPage,
  readWikiPage,
  replaceManagedBlock,
  WikiPageKind,
  writeWikiPage,
} from './markdown.js';
import { VaultPageRecord } from './vault-walk.js';

/** Kinds that get a timeline block. Everything else keeps its body clean. */
const TIMELINE_KINDS = new Set<WikiPageKind>([
  'entity',
  'person',
  'company',
  'project',
  'deal',
]);

const MANAGED_BLOCK_NAME = 'timeline';

export interface TimelineEntry {
  /** ISO-8601 date (no time). Entries with finer precision are still stored. */
  date: string;
  /** Free-form one-line description — shows as the bullet body. */
  text: string;
  /** Rendered as `[Source: who, context, date]` inline with the bullet. */
  who: string;
  context: string;
}

export interface ProjectTimelinesResult {
  pagesWithTimeline: number;
  rewrittenCount: number;
  entriesTotal: number;
  durationMs: number;
}

export interface ProjectTimelinesOptions {
  /**
   * Map of `filePath → ParsedWikiPage` already held by the caller
   * (compile.ts maintains this). When supplied we read the post-related
   * body straight from memory instead of re-reading the file from disk
   * once per eligible page.
   */
  parsedByPath?: Map<string, ParsedWikiPage>;
}

/**
 * Walk the vault's pages + log events, compute a timeline per eligible
 * page, and rewrite the managed block in place. Pages that don't qualify
 * (concepts, notes, sources, reports) are left untouched — timelines
 * only make sense for things with a meaningful chronology.
 */
export function projectTimelines(
  vaultPath: string,
  pages: VaultPageRecord[],
  opts: ProjectTimelinesOptions = {},
): ProjectTimelinesResult {
  const startedAt = Date.now();
  const result: ProjectTimelinesResult = {
    pagesWithTimeline: 0,
    rewrittenCount: 0,
    entriesTotal: 0,
    durationMs: 0,
  };

  // Build lookup indexes once so each page's projection is O(sources+claims+events).
  const sourcePages = pages.filter((p) => p.kind === 'source');
  const logEvents = readLogEvents(vaultPath);

  for (const page of pages) {
    if (!page.kind || !TIMELINE_KINDS.has(page.kind)) continue;
    const entries = buildEntriesForPage({
      page,
      sourcePages,
      logEvents,
    });
    if (entries.length === 0) continue;

    result.pagesWithTimeline++;
    result.entriesTotal += entries.length;

    const blockBody = renderTimelineBlock(entries);
    // Prefer the in-memory post-related body when the caller has it;
    // fall back to a fresh disk read for standalone runs (CLI smoke
    // tests, future tools).
    const parsed =
      opts.parsedByPath?.get(page.filePath) ?? readWikiPage(page.filePath);
    const newBody = replaceManagedBlock(
      parsed.body,
      MANAGED_BLOCK_NAME,
      blockBody,
    );
    if (newBody === parsed.body) continue;
    // Auto-managed-block edit only — skip the version snapshot to
    // avoid amplifying writes by ~N pages per compile pass.
    writeWikiPage(page.filePath, parsed.frontmatter, newBody, {
      writtenBy: 'compile',
      reason: 'timeline projection',
      skipSnapshot: true,
    });
    // Keep the parsed-cache in sync so any later compile step sees
    // the post-projection body.
    if (opts.parsedByPath) {
      opts.parsedByPath.set(page.filePath, {
        frontmatter: parsed.frontmatter,
        body: newBody,
        raw: parsed.raw,
      });
    }
    result.rewrittenCount++;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

// =============================================================================
// Per-page entry collection
// =============================================================================

interface EntrySourceInputs {
  page: VaultPageRecord;
  sourcePages: VaultPageRecord[];
  logEvents: WikiLogLite[];
}

function buildEntriesForPage(inputs: EntrySourceInputs): TimelineEntry[] {
  const { page, sourcePages, logEvents } = inputs;
  const entries: TimelineEntry[] = [];

  // 1. Source pages that cite this page via sourceIds or bridge
  //    relative path matching.
  const basenameLower = page.basename.toLowerCase();
  const pageId = page.frontmatter.id;
  for (const source of sourcePages) {
    const fm = source.frontmatter;
    const ids = Array.isArray(fm.sourceIds) ? fm.sourceIds : [];
    const mentionsById = pageId && ids.includes(pageId);
    const bridgePath =
      typeof fm.bridgeRelativePath === 'string' ? fm.bridgeRelativePath : '';
    const mentionsByPath =
      bridgePath && bridgePath.toLowerCase().includes(basenameLower);
    if (!mentionsById && !mentionsByPath) continue;
    const date = coerceDate(fm.ingestedAt ?? fm.updatedAt ?? fm.extractedAt);
    if (!date) continue;
    entries.push({
      date,
      text: `source ingested: ${getPageTitle(fm, source.basename)}`,
      who: 'bridge',
      context: source.basename,
    });
  }

  // 2. Claims on this page, keyed by updatedAt.
  const claims = Array.isArray(page.frontmatter.claims)
    ? page.frontmatter.claims
    : [];
  for (const claim of claims) {
    const date = coerceDate(claim.updatedAt);
    if (!date) continue;
    entries.push({
      date,
      text: truncate(claim.text, 120),
      who: 'claim',
      context: claim.id ?? 'unknown-id',
    });
  }

  // 3. Log events that touch this page.
  for (const ev of logEvents) {
    if (!eventTouches(ev, page)) continue;
    const date = coerceDate(ev.ts);
    if (!date) continue;
    entries.push({
      date,
      text: `log: ${ev.type}`,
      who: 'wiki-log',
      context: ev.type,
    });
  }

  // Sort chronologically (oldest first).
  entries.sort((a, b) => a.date.localeCompare(b.date));

  // Cap at 50 entries per page — beyond that the block becomes noise.
  // Keep the most recent 50 so the tail (current activity) is always
  // visible; oldest get truncated.
  if (entries.length > 50) {
    return entries.slice(entries.length - 50);
  }
  return entries;
}

function renderTimelineBlock(entries: TimelineEntry[]): string {
  const lines: string[] = [];
  lines.push('_Auto-generated by compile. Do not edit by hand._');
  lines.push('');
  for (const e of entries) {
    lines.push(
      `- ${e.date} — ${e.text} [Source: ${e.who}, ${e.context}, ${e.date}]`,
    );
  }
  return lines.join('\n');
}

// =============================================================================
// Helpers
// =============================================================================

interface WikiLogLite {
  ts: string;
  type: string;
  data?: Record<string, unknown>;
}

function readLogEvents(vaultPath: string): WikiLogLite[] {
  try {
    return readWikiLogEvents(vaultPath) as WikiLogLite[];
  } catch {
    return [];
  }
}

function eventTouches(ev: WikiLogLite, page: VaultPageRecord): boolean {
  if (!ev.data) return false;
  const pageId = page.frontmatter.id;
  if (!pageId) return false;
  // changedSourceIds from bridge-sync events
  const changed = ev.data.changedSourceIds;
  if (Array.isArray(changed) && changed.includes(pageId)) return true;
  // direct pageId key
  if (ev.data.pageId === pageId) return true;
  return false;
}

function coerceDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
