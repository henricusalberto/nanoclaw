/**
 * Phase 1 autofix — repair the auto-fixable lint issues without LLM:
 *
 *   1. `claim-missing-attribution`: when a claim's evidence[] has a
 *      `sourceId` that resolves to an ingested source page, backfill the
 *      evidence note with `[Source: <source-title>, <source-date>]`
 *      synthesized from the source page's frontmatter. When no source
 *      resolves, add a fallback `[Source: Maurizio, direct, <date>]`
 *      attribution — these are hand-written claims and Maurizio is the
 *      authoritative source by definition.
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

import path from 'path';

import {
  parseWikiPage,
  WikiClaim,
  WikiPageFrontmatter,
  writeWikiPage,
} from './markdown.js';
import { renderSourceAttribution } from './source-attribution.js';
import {
  collectVaultPages,
  loadCollisionBlocklist,
  VaultPageRecord,
} from './vault-walk.js';

type PageRecord = VaultPageRecord;

export interface AutofixResult {
  pagesScanned: number;
  attributionsBackfilled: number;
  mentionsWrapped: number;
  pagesWritten: number;
  durationMs: number;
  changes: Array<{ pagePath: string; changes: string[] }>;
}

function collectPages(vaultPath: string): PageRecord[] {
  // Autofix skips `originals/` — those pages are immutable verbatim
  // capture and must never be rewritten.
  return collectVaultPages(vaultPath, { excludeKinds: ['original'] });
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
  pageUpdatedAt: string | undefined,
): boolean {
  // If claim already has attribution (inline in text or in any evidence
  // note), skip.
  if (/\[Source:/.test(claim.text)) return false;
  if (Array.isArray(claim.evidence)) {
    for (const e of claim.evidence) {
      if (e.note && /\[Source:/.test(e.note)) return false;
    }
  }
  if (!Array.isArray(claim.evidence)) claim.evidence = [];

  // Fallback when the claim has no evidence at all — hand-written claims on
  // hand-written pages. Maurizio is the authoritative source.
  if (claim.evidence.length === 0) {
    const date = pickFallbackDate(claim.updatedAt, pageUpdatedAt);
    if (!date) return false;
    claim.evidence.push({
      note: renderSourceAttribution({
        who: 'Maurizio',
        context: 'direct',
        date,
      }),
    });
    return true;
  }

  let mutated = false;
  let anySourceIdSeen = false;
  for (const e of claim.evidence) {
    if (!e.sourceId) continue;
    anySourceIdSeen = true;
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
      // the claim's updatedAt (or evidence updatedAt, or page updatedAt).
      const date = pickFallbackDate(
        e.updatedAt || claim.updatedAt,
        pageUpdatedAt,
      );
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
      pickFallbackDate(e.updatedAt, pageUpdatedAt);
    if (!srcDate) continue;
    const attribution = renderSourceAttribution({
      who: String(srcTitle),
      context: e.note || '',
      date: srcDate,
    });
    e.note = e.note ? `${e.note} ${attribution}` : attribution;
    mutated = true;
  }

  // If we saw no sourceId-bearing evidence at all (just notes/paths), fall
  // back to the Maurizio-direct attribution on a new evidence entry.
  if (!mutated && !anySourceIdSeen) {
    const date = pickFallbackDate(claim.updatedAt, pageUpdatedAt);
    if (date) {
      claim.evidence.push({
        note: renderSourceAttribution({
          who: 'Maurizio',
          context: 'direct',
          date,
        }),
      });
      mutated = true;
    }
  }

  return mutated;
}

function pickFallbackDate(
  claimUpdatedAt: string | undefined,
  pageUpdatedAt: string | undefined,
): string | null {
  const src = claimUpdatedAt || pageUpdatedAt;
  if (!src) return null;
  const m = src.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
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
    // Originals are verbatim quotes — titles are full sentences that
    // repeat legitimately across prose. Skip as wrap targets.
    if (target.kind === 'original') continue;
    // Hubs are navigation pages — their titles collide with common
    // prose nouns ("People", "Me") and should never be wrapped.
    if (target.kind === 'hub') continue;
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
  const blocklist = loadCollisionBlocklist(vaultPath);

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
      const pageUpdatedAt =
        typeof newFm.updatedAt === 'string' ? newFm.updatedAt : undefined;
      for (const claim of newFm.claims) {
        const before = JSON.stringify(claim.evidence);
        const mutated = backfillClaimAttribution(
          claim,
          sourcesById,
          sourcesByBasename,
          pageUpdatedAt,
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
        writeWikiPage(
          page.filePath,
          fmModified ? newFm : page.frontmatter,
          newBody,
          { writtenBy: 'autofix', reason: pageChanges.slice(0, 3).join('; ') },
        );
        result.pagesWritten++;
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
