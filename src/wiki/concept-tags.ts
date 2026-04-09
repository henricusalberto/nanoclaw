/**
 * Lightweight concept tag extraction from snippet text. Capitalized-noun
 * extraction + hyphenated-identifier extraction + stoplist filter, ranked by
 * frequency × length. No glossary, no NLP — just enough to enrich bridge
 * source pages with hints about which entities a memory mentions.
 */

const MAX_CONCEPT_TAGS = 8;
const MIN_TAG_LENGTH = 3;

const CAP_WORD_RE = /\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g;
const HYPHEN_RE = /\b([a-z][a-z0-9]+(?:-[a-z0-9]+){1,4})\b/g;

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
]);

/**
 * Extract concept tags from a snippet body. Returns up to MAX_CONCEPT_TAGS
 * normalized tag strings, ranked by frequency × log(length).
 *
 * @param text          The text to extract from
 * @param extraStopwords  User-supplied stopwords (e.g. their own name) to add
 *                        to the built-in list. Configurable via bridge.json.
 */
export function deriveConceptTags(
  text: string,
  extraStopwords?: string[],
): string[] {
  const tagCounts = new Map<string, number>();
  const stopwords =
    extraStopwords && extraStopwords.length > 0
      ? new Set([...STOPWORDS, ...extraStopwords.map((s) => s.toLowerCase())])
      : STOPWORDS;

  CAP_WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CAP_WORD_RE.exec(text)) !== null) {
    const phrase = m[1].trim();
    if (phrase.length < MIN_TAG_LENGTH) continue;
    const lower = phrase.toLowerCase();
    if (stopwords.has(lower)) continue;
    if (/^\d+$/.test(phrase)) continue;
    const slug = lower.replace(/\s+/g, '-');
    tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
  }

  HYPHEN_RE.lastIndex = 0;
  while ((m = HYPHEN_RE.exec(text)) !== null) {
    const slug = m[1];
    if (slug.length < MIN_TAG_LENGTH) continue;
    if (stopwords.has(slug)) continue;
    tagCounts.set(slug, (tagCounts.get(slug) || 0) + 1);
  }

  return Array.from(tagCounts.entries())
    .map(([tag, count]) => ({ tag, score: count * Math.log(tag.length + 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CONCEPT_TAGS)
    .map((entry) => entry.tag);
}
