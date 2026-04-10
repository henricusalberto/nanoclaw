/**
 * Typed links — additive frontmatter alongside body wikilinks.
 *
 * Body `[[wikilinks]]` are great for prose but lossy: they don't say
 * WHY two pages are connected. Typed links carry a relation type
 * (cites, mentions, contradicts, derives-from, works-with) so the
 * graph traversal API can answer "every page that contradicts X" or
 * "every page derived from Y" without an LLM.
 *
 * Optional and additive — pages without `links:` continue to work as
 * before. The graph builder reads BOTH typed links and body wikilinks
 * so the user never has to choose.
 */

import { WikiPageFrontmatter } from './markdown.js';

export type LinkType =
  | 'cites'
  | 'mentions'
  | 'contradicts'
  | 'derives-from'
  | 'works-with';

export const LINK_TYPES: readonly LinkType[] = [
  'cites',
  'mentions',
  'contradicts',
  'derives-from',
  'works-with',
] as const;

export interface TypedLink {
  type: LinkType;
  /** Page id of the target. Must match a real page's `id` field. */
  target: string;
  /** Optional human-readable note about the relationship. */
  note?: string;
}

/**
 * Read typed links from a page's frontmatter. Defensive: any malformed
 * entries are silently dropped so a typo can't break compile.
 */
export function readTypedLinks(fm: WikiPageFrontmatter): TypedLink[] {
  const raw = (fm as { links?: unknown }).links;
  if (!Array.isArray(raw)) return [];
  const out: TypedLink[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const type = obj.type;
    const target = obj.target;
    if (typeof type !== 'string') continue;
    if (typeof target !== 'string') continue;
    if (!LINK_TYPES.includes(type as LinkType)) continue;
    const link: TypedLink = { type: type as LinkType, target };
    if (typeof obj.note === 'string') link.note = obj.note;
    out.push(link);
  }
  return out;
}
