/**
 * Local HTML file extractor. Strips tags with a tiny handwritten parser —
 * we don't pull in cheerio/jsdom for a feature that mostly gets used on
 * saved browser pages where we just want the readable prose.
 *
 * For full web-page extraction (cleaned article text, boilerplate
 * removal), use the `web` extractor which wraps agent-browser.
 */

import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';

export class HtmlExtractor implements Extractor {
  name = 'html';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'file' || !input.path) return false;
    const ext = path.extname(input.path).toLowerCase();
    return ext === '.html' || ext === '.htm';
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.path) throw new Error('html extractor needs a path');
    const raw = fs.readFileSync(input.path, 'utf-8');
    const title = extractHtmlTitle(raw) ?? path.basename(input.path);
    const body = stripTags(raw);
    return {
      title,
      body,
      mimeType: 'text/html',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        sizeBytes: raw.length,
      },
      originalPath: input.path,
    };
  }
}

function extractHtmlTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim() : null;
}

/**
 * Strip HTML tags and collapse whitespace. Good enough for readability,
 * not good enough for preserving structure — if you need semantic
 * extraction, use the web extractor.
 */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
