/**
 * Plaintext extractor — .txt, .log, .csv, .md. Reads the file directly
 * and returns its contents. The simplest possible extractor, used as a
 * catch-all for any text-like file extension the others don't claim.
 */

import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';

const PLAINTEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.csv',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.env',
  '.ini',
  '.toml',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.env': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'application/toml',
};

export class PlaintextExtractor implements Extractor {
  name = 'plaintext';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'file' || !input.path) return false;
    return PLAINTEXT_EXTS.has(path.extname(input.path).toLowerCase());
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.path) throw new Error('plaintext extractor needs a path');
    const ext = path.extname(input.path).toLowerCase();
    const body = fs.readFileSync(input.path, 'utf-8');
    const stat = fs.statSync(input.path);
    return {
      title: path.basename(input.path),
      body,
      mimeType: MIME_BY_EXT[ext] ?? 'text/plain',
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      },
      originalPath: input.path,
    };
  }
}
