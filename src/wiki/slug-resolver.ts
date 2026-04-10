/**
 * Trigram-Jaccard fuzzy slug resolver.
 *
 * Given an arbitrary input string ("dom inglston" — typo) returns a
 * ranked list of likely page basenames. Pure JS, no dependencies. Fast
 * to ~10k pages because the trigram set is small (≤ length of name).
 *
 * Used by Janus when the user mentions a page by approximate name
 * during a query — instead of grepping the markdown body, ask the
 * resolver and short-circuit to the right page.
 */

export interface SlugCandidate {
  basename: string;
  score: number;
  /** Optional human-readable label (page title). */
  label?: string;
}

export interface ResolverPageInput {
  basename: string;
  title?: string;
  /** Aliases for the page (e.g. former titles, common misspellings). */
  aliases?: string[];
}

/**
 * Score every page against the query string and return up to `limit`
 * candidates above `minScore`. Sorted by descending score.
 */
export function resolveSlug(
  query: string,
  pages: ResolverPageInput[],
  opts: { limit?: number; minScore?: number } = {},
): SlugCandidate[] {
  const limit = opts.limit ?? 10;
  const minScore = opts.minScore ?? 0.2;
  const queryGrams = trigrams(normalize(query));
  if (queryGrams.size === 0) return [];

  const scored: SlugCandidate[] = [];
  for (const page of pages) {
    // Score against the basename + every alias + the title.
    const candidates: string[] = [page.basename];
    if (page.title) candidates.push(page.title);
    if (page.aliases) candidates.push(...page.aliases);
    let best = 0;
    for (const c of candidates) {
      const s = jaccard(queryGrams, trigrams(normalize(c)));
      if (s > best) best = s;
    }
    if (best >= minScore) {
      scored.push({
        basename: page.basename,
        score: best,
        label: page.title,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// =============================================================================
// Internals
// =============================================================================

// Hoisted normalize patterns — `resolveSlug` calls `normalize` once per
// query plus once per (basename + title + alias) per page. Compiling
// them inline meant ~1000 RegExp allocations per query on a 100-page
// vault; module-scope reuses one set forever.
const NORMALIZE_DASH = /[_-]+/g;
const NORMALIZE_PUNCT = /[^a-z0-9\s]/g;
const NORMALIZE_WHITESPACE = /\s+/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(NORMALIZE_DASH, ' ')
    .replace(NORMALIZE_PUNCT, '')
    .replace(NORMALIZE_WHITESPACE, ' ')
    .trim();
}

/**
 * Padded trigrams: surround the input with `  ` and `  ` so prefix
 * and suffix triplets are weighted alongside interior ones. Empty
 * input returns an empty set so an empty query never matches every
 * page (the alternative would be one all-space trigram that pollutes
 * Jaccard scores).
 */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length === 0) return out;
  const padded = `  ${s}  `;
  for (let i = 0; i <= padded.length - 3; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  return inter / (a.size + b.size - inter);
}
