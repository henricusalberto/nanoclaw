import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  diffVersions,
  listVersions,
  readVersion,
  revertToVersion,
  snapshotBeforeWrite,
} from './versions.js';

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-versions-'));
  fs.mkdirSync(path.join(dir, '.openclaw-wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  return dir;
}

function writeRawPage(vault: string, rel: string, body: string): string {
  const abs = path.join(vault, rel);
  fs.writeFileSync(
    abs,
    `---\nid: person.${path.basename(rel, '.md')}\npageType: person\ntitle: ${path.basename(rel, '.md')}\n---\n\n${body}\n`,
  );
  return abs;
}

describe('versions', () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('snapshotBeforeWrite no-ops when the page does not exist', () => {
    const result = snapshotBeforeWrite({
      vaultPath: vault,
      pagePath: path.join(vault, 'people', 'ghost.md'),
      writtenBy: 'test',
    });
    expect(result).toBeNull();
  });

  it('captures the prior body and frontmatter on a real file', () => {
    const pagePath = writeRawPage(vault, 'people/dom.md', 'Hello world');
    const snapPath = snapshotBeforeWrite({
      vaultPath: vault,
      pagePath,
      writtenBy: 'janus',
      reason: 'edit one',
    });
    expect(snapPath).not.toBeNull();
    const versions = listVersions(vault, 'dom');
    expect(versions).toHaveLength(1);
    expect(versions[0].body).toContain('Hello world');
    expect(versions[0].writtenBy).toBe('janus');
    expect(versions[0].reason).toBe('edit one');
    expect(versions[0].pageId).toBe('person.dom');
  });

  it('listVersions returns newest first', () => {
    const pagePath = writeRawPage(vault, 'people/dom.md', 'first');
    snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'a' });
    fs.writeFileSync(
      pagePath,
      `---\nid: person.dom\npageType: person\ntitle: dom\n---\n\nsecond\n`,
    );
    // Tiny delay so the timestamps differ.
    const before = Date.now();
    while (Date.now() === before) {
      /* spin briefly */
    }
    snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'b' });
    const versions = listVersions(vault, 'dom');
    expect(versions).toHaveLength(2);
    expect(versions[0].ts).toBeGreaterThanOrEqual(versions[1].ts);
  });

  it('prunes beyond 50 versions per page', () => {
    const pagePath = writeRawPage(vault, 'people/busy.md', 'v0');
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(
        pagePath,
        `---\nid: person.busy\npageType: person\ntitle: busy\n---\n\nv${i}\n`,
      );
      snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'loop' });
      // Bump time so each snapshot has a unique filename.
      const before = Date.now();
      while (Date.now() === before) {
        /* spin */
      }
    }
    const versions = listVersions(vault, 'busy');
    expect(versions.length).toBeLessThanOrEqual(50);
  });

  it('diffVersions reports + and - lines', () => {
    const pagePath = writeRawPage(vault, 'people/dom.md', 'first');
    snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'a' });
    fs.writeFileSync(
      pagePath,
      `---\nid: person.dom\npageType: person\ntitle: dom\n---\n\nsecond\n`,
    );
    const before = Date.now();
    while (Date.now() === before) {
      /* spin */
    }
    snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'b' });
    const versions = listVersions(vault, 'dom');
    const diff = diffVersions(versions[1], versions[0]);
    expect(diff).toContain('- first');
    expect(diff).toContain('+ second');
  });

  it('revertToVersion restores prior body and snapshots the pre-revert state', () => {
    const pagePath = writeRawPage(vault, 'people/dom.md', 'first');
    snapshotBeforeWrite({ vaultPath: vault, pagePath, writtenBy: 'a' });
    fs.writeFileSync(
      pagePath,
      `---\nid: person.dom\npageType: person\ntitle: dom\n---\n\nsecond\n`,
    );
    const before = Date.now();
    while (Date.now() === before) {
      /* spin */
    }
    const versions = listVersions(vault, 'dom');
    const original = versions[0]; // newest snapshot — has body 'first'
    const result = revertToVersion({
      vaultPath: vault,
      pagePath,
      slug: 'dom',
      ts: original.ts,
      writtenBy: 'manual',
    });
    expect(result.preRevertSnapshot).not.toBeNull();
    const restored = fs.readFileSync(pagePath, 'utf-8');
    expect(restored).toContain('first');
    expect(restored).not.toContain('second');
    // The pre-revert snapshot should now appear in history.
    const history = listVersions(vault, 'dom');
    expect(
      history.some(
        (v) => v.body.includes('second') && v.writtenBy === 'manual',
      ),
    ).toBe(true);
  });

  it('readVersion returns null for unknown ts', () => {
    expect(readVersion(vault, 'ghost', 1234567890)).toBeNull();
  });
});
