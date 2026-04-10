/**
 * Phase 1 autofix — repair the two auto-fixable lint issues without LLM:
 *
 *   1. `claim-missing-attribution`: when a claim's evidence[] has a
 *      `sourceId` that resolves to an ingested source page, backfill the
 *      evidence note with `[Source: <source-title>, <source-date>]`
 *      synthesized from the source page's frontmatter.
 *
 *   2. `unlinked-entity-mention`: when the body of page A mentions the
 *      title of page B (exact, case-sensitive, word-bounded), and A has
 *      no wikilink to B, wrap the first occurrence of the mention in
 *      `[[B-basename|B-title]]`. Subsequent occurrences stay as plain text
 *      (one wikilink per mention is enough; Obsidian's graph view handles
 *      the rest).
 *
 * Both fixes are idempotent. Running autofix twice yields no additional
 * changes on the second run. Writes are atomic via `atomicWriteFile`.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import {
  parseWikiPage,
  readWikiPage,
  serializeWikiPage,
  WikiClaim,
  WikiPageFrontmatter,
  WikiPageKind,
} from './markdown.js';
import { vaultPaths } from './paths.js';
import { renderSourceAttribution } from './source-attribution.js';

const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = [
  { dir: 'entities', kind: 'entity' },
  { dir: 'concepts', kind: 'concept' },
  { dir: 'syntheses', kind: 'synthesis' },
  { dir: 'sources', kind: 'source' },
];

const DEFAULT_BLOCKLIST: string[] = [
  'The',
  'A',
  'An',
  'And',
  'Or',
  'But',
  'If',
  'Then',
  'When',
  'Where',
  'What',
  'Why',
  'How',
  'Who',
  'With',
  'Without',
  'From',
  'To',
  'In',
  'On',
  'At',
  'By',
  'For',
  'Of',
  'As',
  'Is',
  'Was',
  'Are',
  'Were',
  'Be',
  'Been',
  'Being',
  'Have',
  'Has',
  'Had',
  'Do',
  'Does',
  'Did',
  'Will',
  'Would',
  'Could',
  'Should',
  'May',
  'Might',
  'Can',
  'Cannot',
  'Not',
  'No',
  'Yes',
  'All',
  'Any',
  'Each',
  'Every',
  'Some',
  'Most',
  'More',
  'Less',
  'Very',
  'Just',
  'Only',
  'Also',
  'Even',
  'Still',
  'Yet',
  'Now',
  'Then',
  'Here',
  'There',
  'Today',
  'Yesterday',
  'Tomorrow',
  'Wiki',
  'Source',
  'Note',
  'Goal',
  'Status',
  'Overview',
  'Content',
];

interface PageRecord {
  filePath: string;
  relativePath: string;
  basename: string;
  kind: WikiPageKind;
  frontmatter: WikiPageFrontmatter;
  body: string;
}

export interface AutofixResult {
  pagesScanned: number;
  attributionsBackfilled: number;
  mentionsWrapped: number;
  pagesWritten: number;
  durationMs: number;
  changes: Array<{ pagePath: string; changes: string[] }>;
}

// =============================================================================
// Vault walk
// =============================================================================

function collectPages(vaultPath: string): PageRecord[] {
  const records: PageRecord[] = [];
  for (const { dir, kind } of VAULT_DIRS) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md') continue;
      const filePath = path.join(dirPath, entry.name);
      const parsed = readWikiPage(filePath);
      records.push({
        filePath,
        relativePath: path.relative(vaultPath, filePath),
        basename: path.basename(entry.name, '.md').toLowerCase(),
        kind,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    }
  }
  return records;
}

function loadBlocklist(vaultPath: string): Set<string> {
  const blocklistPath = path.join(
    vaultPaths(vaultPath).stateDir,
    'entity-collision-blocklist.json',
  );
  const data = readJsonOrDefault<{ blocklist: string[] }>(blocklistPath, {
    blocklist: DEFAULT_BLOCKLIST,
  });
  const words = Array.isArray(data.blocklist)
    ? data.blocklist
    : DEFAULT_BLOCKLIST;
  return new Set(words.map((w) => w.toLowerCase()));
}

// =============================================================================
// Fix 1: Backfill claim attributions from resolved source pages
// =============================================================================

/**
 * For a claim with `evidence[{sourceId, ...}]` where sourceId resolves to a
 * source page in the vault, synthesize a `[Source: ...]` attribution from
 * the source page's frontmatter and inject it into the evidence entry's
 * `note` field (or append to existing note if already present).
 *
 * Mutates the claim in place. Returns true if any evidence was modified.
 */
function backfillClaimAttribution(
  claim: WikiClaim,
  sourcesById: Map<string, PageRecord>,
  sourcesByBasename: Map<string, PageRecord>,
): boolean {
  if (!Array.isArray(claim.evidence) || claim.evidence.length === 0) {
    return false;
  }
  // If claim already has attribution (inline in text or in any evidence
  // note), skip.
  if (/\[Source:/.test(claim.text)) return false;
  for (const e of claim.evidence) {
    if (e.note && /\[Source:/.test(e.note)) return false;
  }

  let mutated = false;
  for (const e of claim.evidence) {
    if (!e.sourceId) continue;
    // Try to resolve sourceId to an actual source page.
    // sourceId formats we've seen:
    //   "knowledge-files-2026" — abstract label, not a page id
    //   "dom-calls-aug2025" — abstract label
    //   "source.bridge-global-memory-active--..." — proper page id
    //   "bridge-global-memory-active--..." — basename
    let srcPage: PageRecord | undefined =
      sourcesById.get(e.sourceId) ||
      sourcesById.get(`source.${e.sourceId}`) ||
      sourcesByBasename.get(e.sourceId.toLowerCase()) ||
      sourcesByBasename.get(`bridge-${e.sourceId.toLowerCase()}`);
    if (!srcPage) {
      // Abstract label — synthesize attribution from the sourceId itself +
      // the claim's updatedAt (or evidence updatedAt). Better than nothing.
      const date = e.updatedAt
        ? e.updatedAt.slice(0, 10)
        : claim.updatedAt
          ? claim.updatedAt.slice(0, 10)
          : null;
      if (!date) continue;
      const attribution = renderSourceAttribution({
        who: e.sourceId,
        context: e.note || '',
        date,
      });
      e.note = e.note ? `${e.note} ${attribution}` : attribution;
      mutated = true;
      continue;
    }
    // Resolved source page — build attribution from its frontmatter.
    const srcTitle =
      srcPage.frontmatter.title || srcPage.basename || srcPage.relativePath;
    const srcDate =
      (srcPage.frontmatter.ingestedAt as string | undefined)?.slice(0, 10) ||
      (srcPage.frontmatter.updatedAt as string | undefined)?.slice(0, 10) ||
      e.updatedAt?.slice(0, 10) ||
      null;
    if (!srcDate) continue;
    const attribution = renderSourceAttribution({
      who: String(srcTitle),
      context: e.note || '',
      date: srcDate,
    });
    e.note = e.note ? `${e.note} ${attribution}` : attribution;
    mutated = true;
  }
  return mutated;
}

// =============================================================================
// Fix 2: Auto-wrap unlinked entity mentions in wikilinks
// =============================================================================

/**
 * Extract a "scannable prose" view of the body: all regions where wrapping
 * a mention is safe. Returns an array of `{text, start, end}` segments
 * where each segment maps to the original body coordinates.
 */
interface ProseSegment {
  text: string;
  start: number;
  end: number;
}

function extractProseSegments(body: string): ProseSegment[] {
  const excludeRanges: Array<[number, number]> = [];

  // Helper to add a range
  const addExclusion = (re: RegExp) => {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      excludeRanges.push([m.index, m.index + m[0].length]);
    }
  };

  addExclusion(/```[\s\S]*?```/g);
  addExclusion(/~~~[\s\S]*?~~~/g);
  addExclusion(/`[^`\n]+`/g);
  addExclusion(/\[\[[^\]]+\]\]/g);
  addExclusion(/\[[^\]]*\]\([^)]+\)/g);
  addExclusion(
    /<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g,
  );
  addExclusion(
    /<!--\s*openclaw:human:start\s*-->[\s\S]*?<!--\s*openclaw:human:end\s*-->/g,
  );
  addExclusion(/<!--[\s\S]*?-->/g);
  addExclusion(/^#{1,6}\s.*$/gm);

  // Sort and merge exclusion ranges
  excludeRanges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of excludeRanges) {
    if (merged.length === 0 || merged[merged.length - 1][1] < r[0]) {
      merged.push([r[0], r[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(
        merged[merged.length - 1][1],
        r[1],
      );
    }
  }

  // Produce the prose segments — regions NOT in exclude ranges
  const segments: ProseSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) {
      segments.push({
        text: body.slice(cursor, start),
        start: cursor,
        end: start,
      });
    }
    cursor = end;
  }
  if (cursor < body.length) {
    segments.push({
      text: body.slice(cursor),
      start: cursor,
      end: body.length,
    });
  }
  return segments;
}

/**
 * Wrap the first occurrence of `term` (word-boundary, case-sensitive)
 * in a wikilink `[[targetBasename|term]]`. Returns the modified body
 * or null if no safe occurrence found.
 *
 * The match must be within a prose segment (not in a code block,
 * wikilink, etc).
 */
function wrapFirstMention(
  body: string,
  term: string,
  targetBasename: string,
  segments: ProseSegment[],
): string | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);

  for (const seg of segments) {
    const m = seg.text.match(re);
    if (!m) continue;
    const localIdx = m.index!;
    const absoluteIdx = seg.start + localIdx;
    const replacement =
      term === targetBasename || term.toLowerCase() === targetBasename
        ? `[[${targetBasename}]]`
        : `[[${targetBasename}|${term}]]`;
    return (
      body.slice(0, absoluteIdx) +
      replacement +
      body.slice(absoluteIdx + term.length)
    );
  }
  return null;
}

interface MentionToWrap {
  term: string;
  targetBasename: string;
}

function findMentionsToWrap(
  page: PageRecord,
  allPages: PageRecord[],
  blocklist: Set<string>,
): MentionToWrap[] {
  const segments = extractProseSegments(page.body);
  const proseText = segments.map((s) => s.text).join('\n');
  const mentions: MentionToWrap[] = [];

  for (const target of allPages) {
    if (target.filePath === page.filePath) continue;
    const title = (target.frontmatter.title as string | undefined) || '';
    if (title.length < 4 || !/^[A-Z]/.test(title)) continue;
    if (blocklist.has(title.toLowerCase())) continue;

    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(proseText)) {
      mentions.push({ term: title, targetBasename: target.basename });
    }
  }
  return mentions;
}

// =============================================================================
// Main autofix runner
// =============================================================================

export async function runAutofix(
  vaultPath: string,
  opts: { apply: boolean },
): Promise<AutofixResult> {
  const startedAt = Date.now();
  const pages = collectPages(vaultPath);
  const blocklist = loadBlocklist(vaultPath);

  // Index source pages for claim attribution backfill
  const sourcesById = new Map<string, PageRecord>();
  const sourcesByBasename = new Map<string, PageRecord>();
  for (const p of pages) {
    if (p.kind !== 'source') continue;
    if (p.frontmatter.id) sourcesById.set(p.frontmatter.id, p);
    sourcesByBasename.set(p.basename, p);
  }

  const result: AutofixResult = {
    pagesScanned: pages.length,
    attributionsBackfilled: 0,
    mentionsWrapped: 0,
    pagesWritten: 0,
    durationMs: 0,
    changes: [],
  };

  for (const page of pages) {
    const pageChanges: string[] = [];
    let bodyModified = false;
    let fmModified = false;
    let newBody = page.body;
    const newFm = JSON.parse(
      JSON.stringify(page.frontmatter),
    ) as WikiPageFrontmatter;

    // Fix 1: Backfill claim attributions
    if (Array.isArray(newFm.claims)) {
      for (const claim of newFm.claims) {
        const before = JSON.stringify(claim.evidence);
        const mutated = backfillClaimAttribution(
          claim,
          sourcesById,
          sourcesByBasename,
        );
        if (mutated) {
          fmModified = true;
          result.attributionsBackfilled++;
          const after = JSON.stringify(claim.evidence);
          if (before !== after) {
            pageChanges.push(
              `backfilled attribution for claim "${claim.text.slice(0, 40)}..."`,
            );
          }
        }
      }
    }

    // Fix 2: Wrap unlinked entity mentions (one wrap per target per run)
    if (page.kind !== 'source' && page.kind !== 'report') {
      const mentions = findMentionsToWrap(page, pages, blocklist);
      for (const mention of mentions) {
        const segments = extractProseSegments(newBody);
        const wrapped = wrapFirstMention(
          newBody,
          mention.term,
          mention.targetBasename,
          segments,
        );
        if (wrapped !== null) {
          newBody = wrapped;
          bodyModified = true;
          result.mentionsWrapped++;
          pageChanges.push(
            `wrapped first mention of "${mention.term}" as [[${mention.targetBasename}]]`,
          );
        }
      }
    }

    if ((bodyModified || fmModified) && pageChanges.length > 0) {
      result.changes.push({
        pagePath: page.relativePath,
        changes: pageChanges,
      });
      if (opts.apply) {
        const serialized = serializeWikiPage(
          fmModified ? newFm : page.frontmatter,
          newBody,
        );
        atomicWriteFile(page.filePath, serialized);
        result.pagesWritten++;
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
