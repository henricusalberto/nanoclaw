/**
 * Image extractor — OCR + caption via the Claude vision model. Uses the
 * same in-container `claude` CLI pattern as entity-scan, which already
 * knows about the OneCLI proxy.
 *
 * Budget-sensitive: every call burns image input tokens. The bridge
 * should only route to this extractor when `entityScan.enabled` is true
 * (shares the same scan budget) or when explicitly invoked via
 * `wiki extract`.
 */

import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { callClaudeCli } from './claude-cli.js';

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
]);

const IMAGE_EXTRACTION_PROMPT = `Look at the attached image. Produce a JSON object with exactly these fields:
{
  "caption": "1-2 sentence description of what the image shows",
  "ocrText": "any visible text in the image, verbatim, joined with newlines; empty string if none",
  "entities": ["optional array of proper nouns visible in the image"]
}
Return ONLY the JSON object, no prose, no code fence.`;

export class ImageExtractor implements Extractor {
  name = 'image';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'file' || !input.path) return false;
    return IMAGE_EXTS.has(path.extname(input.path).toLowerCase());
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.path) throw new Error('image extractor needs a path');
    const stat = fs.statSync(input.path);

    const result = await callClaudeVision(input.path);

    const bodyLines: string[] = [];
    if (result.caption) {
      bodyLines.push('## Caption', '', result.caption, '');
    }
    if (result.ocrText) {
      bodyLines.push('## Text in image', '', '```', result.ocrText, '```', '');
    }
    if (result.entities && result.entities.length > 0) {
      bodyLines.push(
        '## Entities visible',
        '',
        result.entities.map((e) => `- ${e}`).join('\n'),
        '',
      );
    }
    if (bodyLines.length === 0) {
      bodyLines.push('_(vision model returned no usable content)_');
    }

    return {
      title: path.basename(input.path),
      body: bodyLines.join('\n'),
      mimeType: `image/${path.extname(input.path).slice(1)}`,
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        sizeBytes: stat.size,
        ...(result.entities && { entities: result.entities }),
      },
      originalPath: input.path,
    };
  }
}

interface VisionResult {
  caption: string;
  ocrText: string;
  entities?: string[];
}

/**
 * Delegate to the shared Claude CLI helper with an image attachment.
 * On any failure (spawn/timeout/exit/unparseable JSON) we return an
 * empty result — the caller still writes a source page pointing at
 * the image, just without OCR metadata.
 */
async function callClaudeVision(imagePath: string): Promise<VisionResult> {
  try {
    const { json } = await callClaudeCli({
      prompt: IMAGE_EXTRACTION_PROMPT,
      model: 'claude-haiku-4-5',
      timeoutMs: 90_000,
      imagePath,
    });
    const parsed = (json ?? {}) as VisionResult;
    return {
      caption: typeof parsed.caption === 'string' ? parsed.caption : '',
      ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.filter((e): e is string => typeof e === 'string')
        : undefined,
    };
  } catch {
    return { caption: '', ocrText: '' };
  }
}
