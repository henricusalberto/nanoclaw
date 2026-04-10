/**
 * Generic web page extractor. Catch-all for any http(s) URL not claimed
 * by a more specific extractor (youtube, twitter, fieldtheory bookmark).
 *
 * Wraps the `agent-browser` container skill — `agent-browser open <url>`
 * then `agent-browser snapshot` — because `agent-browser` already handles
 * readability/cleanup and returns cleaned markdown. We deliberately avoid
 * WebFetch here: WebFetch summarises, we want verbatim.
 */

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { spawnCapture } from './spawn-util.js';

export class WebExtractor implements Extractor {
  name = 'web';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'url' || !input.url) return false;
    try {
      const u = new URL(input.url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.url) throw new Error('web extractor needs a url');

    // agent-browser maintains its own session; open then snapshot.
    await spawnCapture('agent-browser', ['open', input.url], {
      timeoutMs: 60_000,
    });
    const snap = await spawnCapture('agent-browser', ['snapshot'], {
      timeoutMs: 30_000,
    });

    const body = snap.stdout.trim();
    const title = extractFirstHeading(body) ?? deriveTitleFromUrl(input.url);

    return {
      title,
      body,
      mimeType: 'text/html',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        snapshotBytes: body.length,
      },
      originalUrl: input.url,
    };
  }
}

function extractFirstHeading(markdown: string): string | null {
  const m = /^#+\s+(.+)$/m.exec(markdown);
  return m ? m[1].trim() : null;
}

function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}
