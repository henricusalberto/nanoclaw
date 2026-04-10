/**
 * Twitter/X tweet extractor. Wraps the existing `x-tweet-fetcher`
 * container skill CLI. Claims URLs matching twitter.com / x.com status
 * patterns before the generic `web` extractor catches them.
 *
 * x-tweet-fetcher is expected to emit JSON on stdout with at minimum
 * `{ text, author, createdAt, url }` — the wiki bridge never cared
 * about exact field layout, so any extra keys pass through into
 * metadata verbatim.
 */

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { spawnCapture } from './spawn-util.js';

const TWITTER_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.twitter.com',
]);

export class TwitterExtractor implements Extractor {
  name = 'twitter';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'url' || !input.url) return false;
    try {
      const u = new URL(input.url);
      if (!TWITTER_HOSTS.has(u.hostname)) return false;
      // Only individual-status URLs, not profile pages or search results.
      return /\/status(?:es)?\/\d+/.test(u.pathname);
    } catch {
      return false;
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.url) throw new Error('twitter extractor needs a url');

    const { stdout } = await spawnCapture(
      'x-tweet-fetcher',
      ['fetch', input.url, '--format', 'json'],
      { timeoutMs: 30_000 },
    );

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error('x-tweet-fetcher did not return JSON');
    }

    const text = typeof parsed.text === 'string' ? parsed.text : '';
    const author =
      typeof parsed.author === 'string' ? parsed.author : 'unknown';
    const createdAt =
      typeof parsed.createdAt === 'string' ? parsed.createdAt : null;

    const bodyLines = [
      `**Author:** ${author}`,
      ...(createdAt ? [`**Posted:** ${createdAt}`] : []),
      '',
      '> ' + text.split('\n').join('\n> '),
    ];

    return {
      title: `${author}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`,
      body: bodyLines.join('\n'),
      mimeType: 'application/x-tweet+json',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: parsed,
      originalUrl: input.url,
    };
  }
}
