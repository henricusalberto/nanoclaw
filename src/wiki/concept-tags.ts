/**
 * Lightweight concept tag extraction from snippet text.
 *
 * Inspired by OpenClaw's `concept-vocabulary.ts` but simplified — we don't
 * carry a glossary or compound-token detector, just basic capitalized-noun
 * extraction with stoplist filtering.
 *
 * Used by the bridge to enrich source pages with auto-detected tags so
 * downstream synthesis can quickly identify which entities a memory mentions.
 */

const MAX_CONCEPT_TAGS = 8;
const MIN_TAG_LENGTH = 3;

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'these',
  'those',
  'have',
  'has',
  'had',
  'will',
  'would',
  'should',
  'could',
  'can',
  'cannot',
  'not',
  'but',
  'about',
  'into',
  'over',
  'under',
  'after',
  'before',
  'while',
  'when',
  'where',
  'what',
  'which',
  'who',
  'whose',
  'why',
  'how',
  'all',
  'any',
  'each',
  'every',
  'some',
  'most',
  'more',
  'less',
  'very',
  'just',
  'only',
  'also',
  'even',
  'still',
  'yet',
  'now',
  'then',
  'here',
  'there',
  'today',
  'yesterday',
  'tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  // Filler verbs/adjectives that capitalize at sentence start
  'good',
  'great',
  'bad',
  'best',
  'worst',
  'new',
  'old',
  'first',
  'last',
  'next',
  'previous',
  'one',
  'two',
  'three',
  'maurizio',
  'janus',
]);

/**
 * Extract concept tags from a snippet body. Returns up to MAX_CONCEPT_TAGS
 * normalized tag strings, ranked by frequency × length.
 */
export function deriveConceptTags(text: string): string[] {
  const tagCounts = new Map<string, number>();

  // Pass 1: capitalized words and phrases
  const capWordRe = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = capWordRe.exec(text)) !== null) {
    const phrase = m[1].trim();
    if (phrase.length < MIN_TAG_LENGTH) continue;
    const lower = phrase.toLowerCase();
    if (STOPWORDS.has(lower)) continue;
    if (/^\d+$/.test(phrase)) continue;
    const slug = lower.replace(/\s+/g, '-');
    tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
  }

  // Pass 2: hyphenated lowercase identifiers ("daily-sip", "facebook-ad-algorithm")
  const hyphenRe = /\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,4})\b/g;
  while ((m = hyphenRe.exec(text)) !== null) {
    const slug = m[1];
    if (slug.length < MIN_TAG_LENGTH) continue;
    if (STOPWORDS.has(slug)) continue;
    tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
  }

  // Rank: frequency × log(length+1) — slight preference for longer phrases
  const ranked = Array.from(tagCounts.entries())
    .map(([tag, count]) => ({
      tag,
      score: count * Math.log(tag.length + 1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONCEPT_TAGS)
    .map((entry) => entry.tag);

  return ranked;
}
