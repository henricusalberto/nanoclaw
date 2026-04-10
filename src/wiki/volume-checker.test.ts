import { describe, expect, it } from 'vitest';

import {
  classify,
  classifyAll,
  THRESHOLDS,
  VolumeMetrics,
} from './volume-checker.js';

function metrics(over: Partial<VolumeMetrics> = {}): VolumeMetrics {
  return {
    ts: '2026-04-10T00:00:00Z',
    pageCount: 0,
    claimCount: 0,
    bytesMarkdown: 0,
    compileTimeMs: 0,
    lintTimeMs: 0,
    pagesAdded30d: 0,
    ...over,
  };
}

describe('classify', () => {
  it('reports OK below WATCH', () => {
    expect(classify(100, THRESHOLDS.pageCount)).toBe('OK');
  });
  it('reports WATCH at the threshold', () => {
    expect(classify(150, THRESHOLDS.pageCount)).toBe('WATCH');
  });
  it('reports RECOMMEND at the threshold', () => {
    expect(classify(300, THRESHOLDS.pageCount)).toBe('RECOMMEND');
  });
  it('reports BUILD NOW at the threshold', () => {
    expect(classify(500, THRESHOLDS.pageCount)).toBe('BUILD NOW');
  });
});

describe('classifyAll', () => {
  it('returns OK for a fresh vault', () => {
    expect(classifyAll(metrics()).level).toBe('OK');
  });

  it('returns WATCH when one metric crosses', () => {
    const r = classifyAll(metrics({ pageCount: 200 }));
    expect(r.level).toBe('WATCH');
    expect(r.metrics.find((m) => m.name === 'pageCount')?.level).toBe('WATCH');
  });

  it('escalates to RECOMMEND when two metrics are in WATCH', () => {
    const r = classifyAll(metrics({ pageCount: 200, claimCount: 800 }));
    expect(r.level).toBe('RECOMMEND');
  });

  it('returns RECOMMEND when one metric reaches the recommend threshold', () => {
    const r = classifyAll(metrics({ pageCount: 350 }));
    expect(r.level).toBe('RECOMMEND');
  });

  it('returns BUILD NOW when any metric reaches that level', () => {
    const r = classifyAll(metrics({ compileTimeMs: 6000 }));
    expect(r.level).toBe('BUILD NOW');
  });

  it('breakdown contains every known metric', () => {
    const r = classifyAll(metrics({ pageCount: 50 }));
    const names = r.metrics.map((m) => m.name).sort();
    expect(names).toEqual(
      [
        'bytesMarkdown',
        'claimCount',
        'compileTimeMs',
        'lintTimeMs',
        'pageCount',
        'pagesAdded30d',
      ].sort(),
    );
  });
});
