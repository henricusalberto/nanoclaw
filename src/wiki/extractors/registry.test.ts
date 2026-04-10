import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { Extractor, ExtractorInput } from './base.js';
import { HtmlExtractor } from './html.js';
import { PlaintextExtractor } from './plaintext.js';
import { ExtractorRegistry } from './registry.js';

function tmpFile(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extractor-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('ExtractorRegistry', () => {
  it('routes a .txt file to plaintext', async () => {
    const registry = new ExtractorRegistry([new PlaintextExtractor()]);
    const p = tmpFile('hello.txt', 'hi world');
    const result = await registry.extract({ kind: 'file', path: p });
    expect(result.extractorName).toBe('plaintext');
    expect(result.body).toBe('hi world');
    expect(result.title).toBe('hello.txt');
    expect(result.mimeType).toBe('text/plain');
  });

  it('routes .html to html extractor, strips tags', async () => {
    const registry = new ExtractorRegistry([
      new HtmlExtractor(),
      new PlaintextExtractor(),
    ]);
    const html =
      '<html><head><title>Doc</title></head><body><p>Hello <b>world</b></p><script>var x=1;</script></body></html>';
    const p = tmpFile('page.html', html);
    const result = await registry.extract({ kind: 'file', path: p });
    expect(result.extractorName).toBe('html');
    expect(result.title).toBe('Doc');
    expect(result.body).toContain('Hello');
    expect(result.body).toContain('world');
    expect(result.body).not.toContain('<script>');
    expect(result.body).not.toContain('var x=1');
  });

  it('returns reference-only on no-match', async () => {
    const registry = new ExtractorRegistry([]);
    const result = await registry.extract({
      kind: 'url',
      url: 'https://example.com',
    });
    expect(result.extractorName).toBe('reference-only');
    expect(result.metadata.failed).toBe(true);
    expect(result.body).toContain('Extraction failed');
  });

  it('returns reference-only when extractor throws', async () => {
    const throwing: Extractor = {
      name: 'throwing',
      version: '1',
      canHandle: () => true,
      extract: async () => {
        throw new Error('kaboom');
      },
    };
    const registry = new ExtractorRegistry([throwing]);
    const result = await registry.extract({
      kind: 'url',
      url: 'https://anywhere',
    });
    expect(result.extractorName).toBe('reference-only');
    expect(result.metadata.reason).toBe('kaboom');
    expect(result.metadata.attemptedExtractor).toBe('throwing');
  });

  it('route() returns first matching extractor in order', () => {
    const first: Extractor = {
      name: 'first',
      version: '1',
      canHandle: (i: ExtractorInput) => i.kind === 'file',
      extract: async () => {
        throw new Error('not called');
      },
    };
    const second: Extractor = {
      name: 'second',
      version: '1',
      canHandle: (i: ExtractorInput) => i.kind === 'file',
      extract: async () => {
        throw new Error('not called');
      },
    };
    const registry = new ExtractorRegistry([first, second]);
    expect(registry.route({ kind: 'file', path: '/x' })?.name).toBe('first');
  });

  it('list() reports all registered extractors', () => {
    const registry = new ExtractorRegistry([
      new PlaintextExtractor(),
      new HtmlExtractor(),
    ]);
    const listed = registry.list();
    expect(listed.map((x) => x.name)).toEqual(['plaintext', 'html']);
  });
});

describe('PlaintextExtractor', () => {
  it('handles various extensions with correct mime types', async () => {
    const p = new PlaintextExtractor();
    for (const ext of ['.txt', '.md', '.csv', '.json', '.yaml']) {
      const file = tmpFile(`x${ext}`, 'content');
      expect(p.canHandle({ kind: 'file', path: file })).toBe(true);
      const result = await p.extract({ kind: 'file', path: file });
      expect(result.extractorName).toBe('plaintext');
      expect(result.body).toBe('content');
    }
  });

  it('rejects binary extensions', () => {
    const p = new PlaintextExtractor();
    expect(p.canHandle({ kind: 'file', path: '/tmp/x.pdf' })).toBe(false);
    expect(p.canHandle({ kind: 'file', path: '/tmp/x.jpg' })).toBe(false);
    expect(p.canHandle({ kind: 'url', url: 'https://x' })).toBe(false);
  });
});
