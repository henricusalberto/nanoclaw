import { describe, expect, it } from 'vitest';

import { resolveSlug, trigrams } from './slug-resolver.js';

describe('trigrams', () => {
  it('pads input and yields character triplets', () => {
    const t = trigrams('dom');
    expect(t.has('  d')).toBe(true);
    expect(t.has(' do')).toBe(true);
    expect(t.has('dom')).toBe(true);
    expect(t.has('om ')).toBe(true);
    expect(t.has('m  ')).toBe(true);
  });

  it('returns empty set for too-short input after padding', () => {
    expect(trigrams('').size).toBe(0);
  });
});

describe('resolveSlug', () => {
  const pages = [
    { basename: 'dom-ingleston', title: 'Dom Ingleston' },
    { basename: 'maurizio-faerber', title: 'Maurizio Faerber' },
    { basename: 'revive-plus-labs', title: 'Revive Plus Labs' },
    { basename: 'klaviyo', title: 'Klaviyo' },
    { basename: 'pinterest-system', title: 'Pinterest System' },
  ];

  it('finds an exact basename match at the top', () => {
    const r = resolveSlug('dom-ingleston', pages);
    expect(r[0].basename).toBe('dom-ingleston');
    expect(r[0].score).toBeGreaterThan(0.9);
  });

  it('handles a typo by ranking the closest first', () => {
    const r = resolveSlug('Dom Ingelston', pages); // missing the 'l' / swap
    expect(r[0].basename).toBe('dom-ingleston');
  });

  it('matches against page title in addition to basename', () => {
    const r = resolveSlug('Maurizio', pages);
    expect(r[0].basename).toBe('maurizio-faerber');
  });

  it('respects minScore and limit', () => {
    const r = resolveSlug('xyz', pages, { minScore: 0.6 });
    expect(r).toEqual([]);
    const r2 = resolveSlug('Pinterest', pages, { limit: 1 });
    expect(r2).toHaveLength(1);
  });

  it('considers aliases when supplied', () => {
    const withAlias = [
      ...pages,
      {
        basename: 'rpl',
        title: 'RPL',
        aliases: ['Revive Plus Labs', 'reviveplus'],
      },
    ];
    const r = resolveSlug('reviveplus', withAlias);
    // Either rpl or revive-plus-labs is acceptable; both should appear high.
    expect(['rpl', 'revive-plus-labs']).toContain(r[0].basename);
  });
});
