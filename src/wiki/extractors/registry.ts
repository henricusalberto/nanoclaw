/**
 * Extractor registry. Single source of truth for "given an input, which
 * extractor handles it?". Plug a new extractor in by constructing it,
 * adding it to `buildDefaultRegistry`, and done — no bridge or CLI
 * changes required.
 *
 * The registry is constructed lazily and memoised per-process so repeated
 * calls from the bridge reuse the same extractor instances.
 */

import { AudioExtractor } from './audio.js';
import {
  buildReferenceOnlyContent,
  ExtractedContent,
  Extractor,
  ExtractorInput,
} from './base.js';
import { FieldtheoryExtractor } from './fieldtheory.js';
import { HtmlExtractor } from './html.js';
import { ImageExtractor } from './image.js';
import { PdfExtractor } from './pdf.js';
import { PlaintextExtractor } from './plaintext.js';
import { TwitterExtractor } from './twitter.js';
import { WebExtractor } from './web.js';
import { YouTubeExtractor } from './youtube.js';

export class ExtractorRegistry {
  private extractors: Extractor[];

  constructor(extractors: Extractor[]) {
    this.extractors = extractors;
  }

  /**
   * Return the first extractor whose `canHandle` matches, or null if
   * nothing claims the input. Order matters — more specific extractors
   * (YouTube by URL) must come before catch-alls (web).
   */
  route(input: ExtractorInput): Extractor | null {
    for (const ex of this.extractors) {
      if (ex.canHandle(input)) return ex;
    }
    return null;
  }

  /**
   * Run the matched extractor. On `canHandle` miss OR extractor throw,
   * return a reference-only stub so the bridge always has something to
   * write.
   */
  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    const extractor = this.route(input);
    if (!extractor) {
      return buildReferenceOnlyContent({
        input,
        reason: 'no extractor matched input',
      });
    }
    try {
      return await extractor.extract(input);
    } catch (err) {
      return buildReferenceOnlyContent({
        input,
        reason: (err as Error).message ?? 'extractor threw',
        attemptedExtractor: extractor.name,
      });
    }
  }

  /** For tests and introspection. */
  list(): { name: string; version: string }[] {
    return this.extractors.map((e) => ({ name: e.name, version: e.version }));
  }
}

let cachedRegistry: ExtractorRegistry | null = null;

/**
 * Build and cache the default extractor registry. Order is deliberate:
 *   1. URL-specific matchers (fieldtheory pull, youtube, twitter) — most
 *      specific URL patterns first so they don't get stolen by `web`.
 *   2. `web` — catch-all for any http(s) URL that nothing else claims.
 *   3. File extractors by extension (pdf, image, audio, html, plaintext).
 */
export function getDefaultRegistry(): ExtractorRegistry {
  if (cachedRegistry) return cachedRegistry;
  cachedRegistry = new ExtractorRegistry([
    new FieldtheoryExtractor(),
    new YouTubeExtractor(),
    new TwitterExtractor(),
    new WebExtractor(),
    new PdfExtractor(),
    new ImageExtractor(),
    new AudioExtractor(),
    new HtmlExtractor(),
    new PlaintextExtractor(),
  ]);
  return cachedRegistry;
}

/** Test helper: wipe the cache so a test can inject a custom registry. */
export function resetRegistryCache(): void {
  cachedRegistry = null;
}
