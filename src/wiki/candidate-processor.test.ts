import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processCandidates, readReviewQueue } from './candidate-processor.js';

interface CandidateRow {
  kind: string;
  name: string;
  entityType?: string;
  quote: string;
  window: {
    windowId: string;
    groupFolder: string;
    openedAt: string;
    closedAt: string;
  };
  extractedAt: string;
}

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-proc-'));
  fs.mkdirSync(path.join(dir, '.openclaw-wiki'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'companies'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'concepts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'originals'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  return dir;
}

function writeCandidates(vault: string, rows: CandidateRow[]): void {
  const file = path.join(vault, '.openclaw-wiki', 'entity-candidates.jsonl');
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeExistingPage(
  vault: string,
  relPath: string,
  id: string,
  title: string,
): void {
  const full = path.join(vault, relPath);
  fs.writeFileSync(
    full,
    `---\nid: ${id}\npageType: ${id.split('.')[0]}\ntitle: ${title}\nsourceIds: []\nclaims: []\ncontradictions: []\nquestions: []\nconfidence: 0.8\nstatus: active\nupdatedAt: 2026-04-10T00:00:00.000Z\n---\n\nexisting body\n`,
  );
}

function candidate(
  over: Partial<CandidateRow> & { name: string; quote: string },
  windowId: string,
): CandidateRow {
  return {
    kind: 'entity-candidate',
    entityType: 'person',
    window: {
      windowId,
      groupFolder: 'backfill-source',
      openedAt: '2026-04-10T00:00:00.000Z',
      closedAt: '2026-04-10T00:00:00.000Z',
    },
    extractedAt: '2026-04-10T00:00:00.000Z',
    ...over,
  };
}

describe('processCandidates Stage 1', () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('drops blocklist names entirely', async () => {
    writeCandidates(vault, [
      candidate({ name: 'Janus', quote: 'Janus is the AI' }, 'w1'),
      candidate({ name: 'lossless-claw', quote: 'lossless-claw ran' }, 'w2'),
      candidate({ name: 'mdat', quote: 'mdat file' }, 'w3'),
    ]);
    // Stub the Stage 2 LLM to never be called
    const result = await processCandidates(vault, {
      stage2Call: async () => [],
    });
    expect(result.blocked).toBe(3);
    expect(result.merged).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.reviewQueueSize).toBe(0);
  });

  it('auto-merges candidates that match an existing page basename', async () => {
    writeExistingPage(
      vault,
      'companies/revive-plus-labs.md',
      'company.revive-plus-labs',
      'Revive Plus Labs',
    );
    writeCandidates(vault, [
      candidate(
        {
          name: 'Revive Plus Labs',
          entityType: 'company',
          quote: 'Revive Plus Labs pivot',
        },
        'w1',
      ),
      candidate(
        {
          name: 'Revive Plus',
          entityType: 'company',
          quote: 'Revive Plus launch',
        },
        'w2',
      ),
    ]);
    const result = await processCandidates(vault, {
      stage2Call: async () => [],
    });
    expect(result.merged).toBeGreaterThanOrEqual(1);
    const pageText = fs.readFileSync(
      path.join(vault, 'companies', 'revive-plus-labs.md'),
      'utf-8',
    );
    // The merged quote should have been appended as a claim.
    expect(pageText).toContain('Revive Plus');
  });

  it('auto-promotes new entity with ≥2 mentions in distinct windows', async () => {
    writeCandidates(vault, [
      candidate(
        {
          name: 'Sweitse Kingma',
          entityType: 'person',
          quote: 'Sweitse Kingma came to the call',
        },
        'w1',
      ),
      candidate(
        {
          name: 'Sweitse Kingma',
          entityType: 'person',
          quote: 'Sweitse handled the legal',
        },
        'w2',
      ),
    ]);
    const result = await processCandidates(vault, {
      stage2Call: async () => [],
    });
    expect(result.promoted).toBeGreaterThanOrEqual(1);
    const peopleFiles = fs.readdirSync(path.join(vault, 'people'));
    expect(peopleFiles.some((f) => f.includes('sweitse'))).toBe(true);
  });

  it('escalates rule-miss candidates to Stage 2', async () => {
    let stage2Called = false;
    writeCandidates(vault, [
      candidate(
        {
          name: 'Ambiguous Thing',
          entityType: 'concept',
          quote: 'some snippet',
        },
        'w1',
      ),
    ]);
    await processCandidates(vault, {
      stage2Call: async (batch) => {
        stage2Called = true;
        return batch.map(() => ({ action: 'discard', note: 'noise' }));
      },
    });
    expect(stage2Called).toBe(true);
  });

  it('applies Stage 2 discard action without creating pages', async () => {
    writeCandidates(vault, [
      candidate(
        { name: 'Some Weird Thing', entityType: 'concept', quote: 'snippet' },
        'w1',
      ),
    ]);
    const result = await processCandidates(vault, {
      stage2Call: async (batch) =>
        batch.map(() => ({ action: 'discard' as const })),
    });
    expect(result.llmDiscarded).toBe(1);
    expect(result.reviewQueueSize).toBe(0);
  });

  it('writes ask-user decisions to the review queue', async () => {
    writeCandidates(vault, [
      candidate(
        {
          name: 'Definitely Ambiguous',
          entityType: 'concept',
          quote: 'context',
        },
        'w1',
      ),
    ]);
    const result = await processCandidates(vault, {
      stage2Call: async (batch) =>
        batch.map(() => ({
          action: 'ask-user' as const,
          note: 'genuinely unclear',
        })),
    });
    expect(result.reviewQueueSize).toBe(1);
    const queue = readReviewQueue(vault);
    expect(queue).toHaveLength(1);
    expect(queue[0].name).toBe('Definitely Ambiguous');
    expect(queue[0].reason).toBe('llm-ambiguous');
    expect(queue[0].llmNote).toBe('genuinely unclear');
  });

  it('saves distinct original-thinking quotes to originals/', async () => {
    const originals: CandidateRow[] = [
      {
        kind: 'original-thinking',
        name: '',
        quote: 'This is a distinctive thought worth preserving forever',
        window: {
          windowId: 'w1',
          groupFolder: 'backfill-source',
          openedAt: '2026-04-10T00:00:00.000Z',
          closedAt: '2026-04-10T00:00:00.000Z',
        },
        extractedAt: '2026-04-10T00:00:00.000Z',
      },
      // Duplicate of above — should dedupe
      {
        kind: 'original-thinking',
        name: '',
        quote: 'This is a distinctive thought worth preserving forever',
        window: {
          windowId: 'w2',
          groupFolder: 'backfill-source',
          openedAt: '2026-04-10T00:00:00.000Z',
          closedAt: '2026-04-10T00:00:00.000Z',
        },
        extractedAt: '2026-04-10T00:00:00.000Z',
      },
    ];
    writeCandidates(vault, originals);
    const result = await processCandidates(vault, {
      stage2Call: async () => [],
    });
    expect(result.originalsSaved).toBe(1);
    const files = fs.readdirSync(path.join(vault, 'originals'));
    expect(files.length).toBe(1);
  });

  it('drains the candidates file after a successful run', async () => {
    writeCandidates(vault, [
      candidate({ name: 'Janus', quote: 'noise' }, 'w1'),
    ]);
    await processCandidates(vault, { stage2Call: async () => [] });
    const content = fs.readFileSync(
      path.join(vault, '.openclaw-wiki', 'entity-candidates.jsonl'),
      'utf-8',
    );
    expect(content).toBe('');
  });
});
