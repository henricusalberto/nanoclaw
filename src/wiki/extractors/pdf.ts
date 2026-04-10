/**
 * PDF extractor. Wraps the existing `pdf-reader` container skill CLI,
 * which already knows how to handle layout preservation, multi-column
 * text, and bare-text fallback via poppler-utils.
 *
 * Lives only on files — we don't fetch PDFs from URLs here. To ingest
 * a remote PDF, download it first (e.g., `curl -sLo sources/foo.pdf ...`)
 * then run the bridge or `wiki extract`.
 */

import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { spawnCapture } from './spawn-util.js';

export class PdfExtractor implements Extractor {
  name = 'pdf';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'file' || !input.path) return false;
    return path.extname(input.path).toLowerCase() === '.pdf';
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.path) throw new Error('pdf extractor needs a path');

    const { stdout } = await spawnCapture(
      'pdf-reader',
      ['extract', input.path, '--layout'],
      { timeoutMs: 120_000 },
    );

    const stat = fs.statSync(input.path);
    const pageMatch = /^Pages:\s*(\d+)/m.exec(stdout);
    const pages = pageMatch ? parseInt(pageMatch[1], 10) : undefined;

    return {
      title: path.basename(input.path, '.pdf'),
      body: stdout.trim(),
      mimeType: 'application/pdf',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        sizeBytes: stat.size,
        ...(pages !== undefined && { pages }),
      },
      originalPath: input.path,
    };
  }
}
