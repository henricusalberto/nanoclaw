/**
 * Stub-creation pass — generates skeleton wiki pages for entities that
 * are mentioned in N+ existing claims but don't yet have a page of
 * their own.
 *
 * The dream cycle's enrichment pass operates on EXISTING pages. This
 * pass operates on entities that ought to exist but don't, by mining
 * the structured `claims[]` and `evidence[]` data the wiki already
 * holds. Each detected unstubbed entity gets a stub page with the
 * citing claims as initial evidence — Janus then curates the stub on
 * his next wake.
 *
 * Pure: no LLM calls, no external state. Routes through the resolver
 * to pick the right MECE directory for each new page.
 */

import path from 'path';

import { writeWikiPage, WikiClaim } from './markdown.js';
import { resolveForVault } from './resolver.js';
import { collectVaultPages } from './vault-walk.js';

export interface StubCandidate {
  /** Display name as it should appear on the new page. */
  name: string;
  /** Lowercased basename used for filename + dedup key. */
  basename: string;
  /** Number of distinct source pages mentioning this entity. */
  mentionCount: number;
  /** First few claim ids that cite this entity. */
  citingClaimIds: string[];
  /** Resolver decision: where the new stub should live. */
  directory: string;
  /** Resolver-assigned page kind. */
  kind: string;
  /** Whether the resolver was confident enough to auto-create. */
  autoCreate: boolean;
}

export interface CreateStubsOptions {
  /** Threshold for "mentioned in N+ pages". Default 3. */
  minMentions?: number;
  /** Pure detection only — do not write any pages. */
  dryRun?: boolean;
  /**
   * Skip entities whose resolver decision falls into these directories
   * (e.g. inbox/ — low-confidence catchall, not worth a stub).
   */
  excludeDirs?: string[];
}

export interface CreateStubsResult {
  candidates: StubCandidate[];
  written: number;
  skippedExisting: number;
  skippedLowConfidence: number;
}

const NAME_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
const STOPNAMES = new Set([
  // Articles + demonstratives
  'The',
  'A',
  'An',
  'This',
  'That',
  'These',
  'Those',
  // Prepositions / time markers that capitalize at sentence start
  'On',
  'In',
  'At',
  'By',
  'For',
  'From',
  'To',
  'With',
  'About',
  'After',
  'Before',
  'During',
  'Since',
  'Until',
  // Date words
  'Daily',
  'Weekly',
  'Monthly',
  'Today',
  'Yesterday',
  'Tomorrow',
  'Last',
  'Next',
  'Recent',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
  // Generic page-structure tokens
  'Source',
  'Status',
  'Note',
  'Notes',
  'Wiki',
  'Page',
  'Section',
  'Goal',
  'Goals',
  'Summary',
  'Overview',
  'Content',
  // Frequent first-person/auxiliary
  'I',
  'We',
  'You',
  'He',
  'She',
  'They',
  'Will',
  'Would',
  'Should',
  'Could',
  'Can',
  'May',
  'Might',
  'Must',
  'Did',
  'Does',
  'Has',
  'Have',
  'Had',
  'Is',
  'Was',
  'Were',
  'Be',
  'Been',
]);

/**
 * Walk the vault, mine entity names from claim text, count mentions,
 * route each through the resolver, return the candidates that meet the
 * minMentions threshold and aren't already stubbed.
 */
export function findStubCandidates(
  vaultPath: string,
  opts: CreateStubsOptions = {},
): StubCandidate[] {
  const minMentions = opts.minMentions ?? 3;
  const excludeDirs = new Set(opts.excludeDirs ?? ['inbox', 'reports']);

  const pages = collectVaultPages(vaultPath);
  const existingByBasename = new Set(pages.map((p) => p.basename));

  // name → set of source page ids that mention it
  const mentionsByName = new Map<string, Set<string>>();
  // name → first 3 claim ids that mention it (for citation seeding)
  const claimsByName = new Map<string, string[]>();

  for (const page of pages) {
    const claims = Array.isArray(page.frontmatter.claims)
      ? (page.frontmatter.claims as WikiClaim[])
      : [];
    if (claims.length === 0) continue;

    for (const claim of claims) {
      if (!claim.text || typeof claim.text !== 'string') continue;
      const names = mineNames(claim.text);
      for (const name of names) {
        const set = mentionsByName.get(name) ?? new Set<string>();
        set.add(page.basename);
        mentionsByName.set(name, set);

        if (claim.id) {
          const ids = claimsByName.get(name) ?? [];
          if (ids.length < 3 && !ids.includes(claim.id)) {
            ids.push(claim.id);
          }
          claimsByName.set(name, ids);
        }
      }
    }
  }

  const candidates: StubCandidate[] = [];
  for (const [name, mentioningPages] of mentionsByName) {
    if (mentioningPages.size < minMentions) continue;
    const basename = name.toLowerCase().replace(/\s+/g, '-');
    if (existingByBasename.has(basename)) continue;
    if (STOPNAMES.has(name)) continue;

    const decision = resolveForVault(vaultPath, { title: name });
    if (excludeDirs.has(decision.directory)) continue;

    candidates.push({
      name,
      basename,
      mentionCount: mentioningPages.size,
      citingClaimIds: claimsByName.get(name) ?? [],
      directory: decision.directory,
      kind: decision.kind,
      autoCreate: decision.confidence >= 0.5,
    });
  }

  // Sort: most-mentioned first, ties broken by name length (descending —
  // "Dom Ingleston" before "Dom").
  candidates.sort((a, b) => {
    if (b.mentionCount !== a.mentionCount) {
      return b.mentionCount - a.mentionCount;
    }
    return b.name.length - a.name.length;
  });

  return candidates;
}

/**
 * Write stub pages for every candidate that the resolver routed with
 * confidence ≥ 0.5. Each stub gets minimal frontmatter and a body
 * pointing at the citing claims so Janus knows where the entity came
 * from.
 */
export function createStubsFromCandidates(
  vaultPath: string,
  candidates: StubCandidate[],
  opts: CreateStubsOptions = {},
): CreateStubsResult {
  const result: CreateStubsResult = {
    candidates,
    written: 0,
    skippedExisting: 0,
    skippedLowConfidence: 0,
  };
  if (opts.dryRun) return result;

  for (const c of candidates) {
    if (!c.autoCreate) {
      result.skippedLowConfidence++;
      continue;
    }
    const targetPath = path.join(vaultPath, c.directory, `${c.basename}.md`);

    const ts = new Date().toISOString();
    const stubBody = [
      `# ${c.name}`,
      '',
      `_Auto-created by stub-creator on ${ts.slice(0, 10)}. Mentioned in ${c.mentionCount} source pages with claims; promote or refine as needed._`,
      '',
      '## Initial citations',
      '',
      ...c.citingClaimIds.map((id) => `- claim \`${id}\``),
      '',
      '## Notes',
      '',
      '<!-- openclaw:human:start -->',
      '',
      '<!-- openclaw:human:end -->',
      '',
    ].join('\n');

    writeWikiPage(
      targetPath,
      {
        id: `${c.kind}.${c.basename}`,
        pageType: c.kind as never,
        title: c.name,
        sourceIds: [],
        claims: [],
        contradictions: [],
        questions: [],
        confidence: 0.4,
        status: 'active',
        updatedAt: ts,
      },
      stubBody,
      {
        writtenBy: 'stub-creator',
        reason: `auto-stub from ${c.mentionCount} mentions`,
      },
    );
    result.written++;
  }
  return result;
}

// =============================================================================
// Helpers
// =============================================================================

function mineNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Reset lastIndex per call since the regex is module-scoped + global.
  NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_RE.exec(text)) !== null) {
    const candidate = m[1].trim();
    if (candidate.length < 4) continue;
    const tokens = candidate.split(/\s+/);
    // Single-word names must be ≥ 6 chars to avoid common-word noise
    // ("Call", "Page", "Note" — all single capitalized words that start
    // sentences). Multi-word names are rarer and more likely real.
    if (tokens.length === 1 && candidate.length < 6) continue;
    // Reject when the LEADING token is a stopword — "On March", "The
    // Pinterest", "Daily Sip" all start with a noise token that the
    // regex would otherwise glue to the real entity name.
    if (STOPNAMES.has(tokens[0])) continue;
    if (tokens.every((t) => STOPNAMES.has(t))) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}
