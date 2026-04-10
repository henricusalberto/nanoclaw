/**
 * Audio extractor — stub. Produces a reference-only page pointing at the
 * audio file. Swap this for a real whisper.cpp wrapper later without
 * touching the bridge or registry.
 */

import fs from 'fs';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';

const AUDIO_EXTS = new Set([
  '.mp3',
  '.m4a',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
]);

export class AudioExtractor implements Extractor {
  name = 'audio';
  version = '1-stub';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'file' || !input.path) return false;
    return AUDIO_EXTS.has(path.extname(input.path).toLowerCase());
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.path) throw new Error('audio extractor needs a path');
    const stat = fs.statSync(input.path);
    return {
      title: path.basename(input.path),
      body: [
        '**Audio file — transcription disabled.**',
        '',
        'Install whisper.cpp and wire it into `src/wiki/extractors/audio.ts`',
        'to enable automatic transcription. Until then this source page',
        'exists so Janus at least knows the audio is here.',
      ].join('\n'),
      mimeType: `audio/${path.extname(input.path).slice(1)}`,
      extractorName: this.name,
      extractorVersion: this.version,
      extractedAt: new Date().toISOString(),
      metadata: {
        transcriptionDisabled: true,
        sizeBytes: stat.size,
      },
      originalPath: input.path,
    };
  }
}
