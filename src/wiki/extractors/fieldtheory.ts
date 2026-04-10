/**
 * Fieldtheory extractor. Wraps Maurizio's local `ft` CLI for X bookmarks.
 *
 * Two-mode API:
 *   - `ft list --format json --after <date>` → array of bookmark summaries
 *     (used by the bookmark-sync cron via the bridge pull-source path)
 *   - `ft show <id> --format json` → full bookmark detail
 *
 * `ft` already classifies bookmarks with `category` (tool|technique|
 * research|opinion|launch|security|commerce) and `domain` (ai|marketing|
 * finance|web-dev|etc) at capture time. We preserve these verbatim in
 * frontmatter so Phase 3 hub routing can use them.
 *
 * Canonical bookmark-id input: `ft:<id>` where <id> is whatever `ft`
 * uses internally. The bridge's pull-source loop synthesises these
 * from `ft list` output.
 */

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { spawnCapture } from './spawn-util.js';

export class FieldtheoryExtractor implements Extractor {
  name = 'fieldtheory';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'bookmark-id' || !input.bookmarkId) return false;
    return input.bookmarkId.startsWith('ft:');
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.bookmarkId)
      throw new Error('fieldtheory extractor needs a bookmarkId');
    const rawId = input.bookmarkId.replace(/^ft:/, '');

    const { stdout } = await spawnCapture(
      'ft',
      ['show', rawId, '--format', 'json'],
      { timeoutMs: 30_000 },
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`ft show ${rawId} returned non-JSON`);
    }

    const text = asString(parsed.text) ?? asString(parsed.body) ?? '';
    const author = asString(parsed.author) ?? 'unknown';
    const url = asString(parsed.url) ?? '';
    const bookmarkedAt = asString(parsed.bookmarkedAt) ?? '';
    const category = asString(parsed.category);
    const domain = asString(parsed.domain);
    const title =
      asString(parsed.title) ?? `${author}: ${text.slice(0, 60)}`.trim();

    const bodyLines = [
      `**Author:** ${author}`,
      ...(bookmarkedAt ? [`**Bookmarked:** ${bookmarkedAt}`] : []),
      ...(category ? [`**Category:** ${category}`] : []),
      ...(domain ? [`**Domain:** ${domain}`] : []),
      ...(url ? [`**URL:** ${url}`] : []),
      '',
      text ? '> ' + text.split('\n').join('\n> ') : '(no text content)',
    ];

    return {
      title,
      body: bodyLines.join('\n'),
      mimeType: 'application/x-fieldtheory-bookmark+json',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      // Preserve the entire ft record — downstream routing logic in
      // SKILL.md reads category and domain off of this.
      metadata: parsed,
      originalUrl: url || undefined,
    };
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * List bookmarks added since `afterIso`. Wrapped here so the bridge
 * pull-source loop has a single import path for both listing and
 * per-bookmark extraction. Returns an empty array on any failure —
 * pull sources must never crash a bridge sync.
 */
export async function listFieldtheoryBookmarks(
  afterIso: string,
): Promise<FieldtheoryBookmarkSummary[]> {
  try {
    const { stdout } = await spawnCapture(
      'ft',
      ['list', '--format', 'json', '--after', afterIso],
      { timeoutMs: 30_000 },
    );
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is Record<string, unknown> =>
          typeof x === 'object' && x !== null,
      )
      .map((r) => ({
        id: asString(r.id) ?? '',
        title: asString(r.title),
        author: asString(r.author),
        url: asString(r.url),
        bookmarkedAt: asString(r.bookmarkedAt),
        category: asString(r.category),
        domain: asString(r.domain),
      }))
      .filter((b) => b.id !== '');
  } catch {
    return [];
  }
}

export interface FieldtheoryBookmarkSummary {
  id: string;
  title?: string;
  author?: string;
  url?: string;
  bookmarkedAt?: string;
  category?: string;
  domain?: string;
}
