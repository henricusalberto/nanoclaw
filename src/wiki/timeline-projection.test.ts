import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectTimelines } from './timeline-projection.js';
import { VaultPageRecord } from './vault-walk.js';

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-'));
  fs.mkdirSync(path.join(dir, '.openclaw-wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'companies'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  return dir;
}

function writePage(
  vault: string,
  relPath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): VaultPageRecord {
  const abs = path.join(vault, relPath);
  const fm = [
    '---',
    Object.entries(frontmatter)
      .map(([k, v]) =>
        typeof v === 'string' ? `${k}: ${v}` : `${k}: ${JSON.stringify(v)}`,
      )
      .join('\n'),
    '---',
    '',
    body,
  ].join('\n');
  fs.writeFileSync(abs, fm);
  return {
    filePath: abs,
    relativePath: relPath,
    basename: path.basename(relPath, '.md').toLowerCase(),
    dir: path.dirname(relPath),
    kind: (frontmatter.pageType as VaultPageRecord['kind']) ?? undefined,
    expectedKind:
      (frontmatter.pageType as VaultPageRecord['expectedKind']) ?? 'inbox-item',
    frontmatter: frontmatter as VaultPageRecord['frontmatter'],
    body,
  };
}

describe('projectTimelines', () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('skips pages whose kind is not in TIMELINE_KINDS', () => {
    const concept = writePage(
      vault,
      'people/idea.md',
      { id: 'concept.x', pageType: 'concept', title: 'X' },
      'body',
    );
    const result = projectTimelines(vault, [concept]);
    expect(result.rewrittenCount).toBe(0);
  });

  it('projects source-page entries by sourceIds lookup', () => {
    const entity = writePage(
      vault,
      'people/dom.md',
      { id: 'person.dom', pageType: 'person', title: 'Dom Ingleston' },
      '# Dom\n',
    );
    const source = writePage(
      vault,
      'sources/bridge-abc.md',
      {
        id: 'source.bridge-abc',
        pageType: 'source',
        title: 'Bridge: abc',
        sourceIds: ['person.dom'],
        ingestedAt: '2026-03-21T10:00:00Z',
      },
      'source body',
    );
    const result = projectTimelines(vault, [entity, source]);
    expect(result.rewrittenCount).toBe(1);
    expect(result.entriesTotal).toBe(1);
    const rewritten = fs.readFileSync(entity.filePath, 'utf-8');
    expect(rewritten).toContain('openclaw:wiki:timeline:start');
    expect(rewritten).toContain('2026-03-21');
    expect(rewritten).toContain('[Source: bridge,');
  });

  it('projects claims with updatedAt', () => {
    const entity = writePage(
      vault,
      'companies/acme.md',
      {
        id: 'company.acme',
        pageType: 'company',
        title: 'Acme',
        claims: [
          {
            id: 'acme.founded',
            text: 'Founded in 2020',
            evidence: [],
            updatedAt: '2026-02-15T00:00:00Z',
          },
        ],
      },
      '',
    );
    const result = projectTimelines(vault, [entity]);
    expect(result.rewrittenCount).toBe(1);
    const body = fs.readFileSync(entity.filePath, 'utf-8');
    expect(body).toContain('2026-02-15');
    expect(body).toContain('Founded in 2020');
  });

  it('caps entries at 50 keeping the most recent', () => {
    const claims = [];
    for (let i = 0; i < 60; i++) {
      claims.push({
        id: `c${i}`,
        text: `claim ${i}`,
        evidence: [],
        updatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      });
    }
    const entity = writePage(
      vault,
      'people/busy.md',
      { id: 'person.busy', pageType: 'person', title: 'Busy Person', claims },
      '',
    );
    const result = projectTimelines(vault, [entity]);
    expect(result.entriesTotal).toBeLessThanOrEqual(50);
  });

  it('is idempotent — running twice produces same file bytes', () => {
    const entity = writePage(
      vault,
      'people/dom.md',
      {
        id: 'person.dom',
        pageType: 'person',
        title: 'Dom',
        claims: [
          {
            id: 'c1',
            text: 'claim one',
            evidence: [],
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      '# Dom\n',
    );
    projectTimelines(vault, [entity]);
    const firstPass = fs.readFileSync(entity.filePath, 'utf-8');
    projectTimelines(vault, [entity]);
    const secondPass = fs.readFileSync(entity.filePath, 'utf-8');
    expect(secondPass).toBe(firstPass);
  });

  it('does not touch pages with no timeline sources', () => {
    const entity = writePage(
      vault,
      'people/empty.md',
      { id: 'person.empty', pageType: 'person', title: 'Empty' },
      '# Empty\n',
    );
    const result = projectTimelines(vault, [entity]);
    expect(result.rewrittenCount).toBe(0);
    const body = fs.readFileSync(entity.filePath, 'utf-8');
    expect(body).not.toContain('openclaw:wiki:timeline');
  });
});
