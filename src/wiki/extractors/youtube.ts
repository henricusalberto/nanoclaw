/**
 * YouTube extractor. Wraps `yt-dlp` to fetch auto-generated subtitles
 * (or uploaded captions when present) without downloading the video
 * itself. Output: the transcript as markdown with timestamps optional.
 *
 * `yt-dlp --skip-download --write-auto-subs --write-subs --sub-lang en
 * --sub-format vtt -o <tmpl> <url>` produces a `.vtt` sidecar we then
 * convert to plain markdown.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { ExtractedContent, Extractor, ExtractorInput } from './base.js';
import { spawnCapture } from './spawn-util.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

export class YouTubeExtractor implements Extractor {
  name = 'youtube';
  version = '1';

  canHandle(input: ExtractorInput): boolean {
    if (input.kind !== 'url' || !input.url) return false;
    try {
      const u = new URL(input.url);
      return YOUTUBE_HOSTS.has(u.hostname);
    } catch {
      return false;
    }
  }

  async extract(input: ExtractorInput): Promise<ExtractedContent> {
    if (!input.url) throw new Error('youtube extractor needs a url');

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-yt-'));
    try {
      // Single yt-dlp invocation: `-J` emits metadata JSON on stdout
      // AND the sibling --write-auto-subs/--write-subs flags drop a
      // .vtt next to the (skipped) video download. Previously this
      // was two separate yt-dlp runs, each paying process-start cost.
      const meta = await spawnCapture(
        'yt-dlp',
        [
          '-J',
          '--skip-download',
          '--write-auto-subs',
          '--write-subs',
          '--sub-lang',
          'en.*',
          '--sub-format',
          'vtt',
          '--no-warnings',
          '-o',
          path.join(workDir, '%(id)s.%(ext)s'),
          input.url,
        ],
        { timeoutMs: 120_000 },
      );

      let title = 'YouTube video';
      let uploader: string | undefined;
      let duration: number | undefined;
      let description: string | undefined;
      try {
        const json = JSON.parse(meta.stdout) as {
          title?: string;
          uploader?: string;
          duration?: number;
          description?: string;
          id?: string;
        };
        if (json.title) title = json.title;
        uploader = json.uploader;
        duration = json.duration;
        description = json.description;
      } catch {
        // metadata unparseable — fall through with whatever we've got
      }

      const vttFile = fs.readdirSync(workDir).find((f) => f.endsWith('.vtt'));
      const transcript = vttFile
        ? vttToPlainText(fs.readFileSync(path.join(workDir, vttFile), 'utf-8'))
        : '(no transcript available)';

      const bodyLines: string[] = [`# ${title}`, ''];
      if (uploader) bodyLines.push(`**Uploader:** ${uploader}`);
      if (duration !== undefined)
        bodyLines.push(`**Duration:** ${formatDuration(duration)}`);
      bodyLines.push('');
      if (description) {
        bodyLines.push('## Description', '', description.trim(), '');
      }
      bodyLines.push('## Transcript', '', transcript);

      return {
        title,
        body: bodyLines.join('\n'),
        mimeType: 'video/youtube',
        extractorName: this.name,
        extractorVersion: this.version,
        extractedAt: new Date().toISOString(),
        metadata: {
          ...(uploader && { uploader }),
          ...(duration !== undefined && { durationSeconds: duration }),
          transcriptAvailable: transcript !== '(no transcript available)',
        },
        originalUrl: input.url,
      };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * Strip VTT timestamps and cue metadata, collapsing repeats. Good enough
 * for pulling claims out of YouTube captions — not trying to preserve
 * exact alignment.
 */
function vttToPlainText(vtt: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const raw of vtt.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT') continue;
    if (line.startsWith('NOTE')) continue;
    if (line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}/.test(line)) continue; // cue timing
    if (/^\d+$/.test(line)) continue; // cue index
    // Strip inline timestamp tags and position attributes.
    const clean = line
      .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')
      .replace(/<\/?c[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (!clean) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    lines.push(clean);
  }
  return lines.join('\n');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}
