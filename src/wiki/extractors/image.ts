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

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';

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
 * Call `claude -p --bare --model claude-haiku-4-5 --image <path>` with
 * the extraction prompt. The claude CLI handles auth via OneCLI proxy
 * in-container. We swallow malformed JSON responses — graceful degradation.
 */
async function callClaudeVision(imagePath: string): Promise<VisionResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--bare',
      '--model',
      'claude-haiku-4-5',
      '--output-format',
      'text',
      '--image',
      imagePath,
      '--dangerously-skip-permissions',
      IMAGE_EXTRACTION_PROMPT,
    ];

    const child = spawn('claude', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude vision call timed out'));
    }, 90_000);

    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI failed: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `claude exited ${code}: ${Buffer.concat(stderrChunks)
              .toString('utf-8')
              .slice(0, 500)}`,
          ),
        );
        return;
      }
      const raw = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      try {
        // Be forgiving — some models wrap JSON in fences even when told not to.
        const cleaned = raw
          .replace(/^```(?:json)?\n/, '')
          .replace(/\n```$/, '');
        const parsed = JSON.parse(cleaned) as VisionResult;
        resolve({
          caption: typeof parsed.caption === 'string' ? parsed.caption : '',
          ocrText: typeof parsed.ocrText === 'string' ? parsed.ocrText : '',
          entities: Array.isArray(parsed.entities)
            ? parsed.entities.filter((e): e is string => typeof e === 'string')
            : undefined,
        });
      } catch {
        // Unparseable → empty result. Caller still writes a page.
        resolve({ caption: '', ocrText: '' });
      }
    });
  });
}
