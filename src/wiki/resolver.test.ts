import { describe, expect, it } from 'vitest';

import { resolve, titleToBasename } from './resolver.js';

describe('titleToBasename', () => {
  it('kebab-cases simple titles', () => {
    expect(titleToBasename('Dom Ingleston')).toBe('dom-ingleston.md');
    expect(titleToBasename('Revive Plus Labs')).toBe('revive-plus-labs.md');
  });

  it('strips apostrophes and punctuation', () => {
    expect(titleToBasename("Maurizio's Pinterest")).toBe(
      'maurizios-pinterest.md',
    );
    expect(titleToBasename('A/B test!')).toBe('a-b-test.md');
  });

  it('caps at 80 chars plus .md', () => {
    const long = 'x'.repeat(200);
    const basename = titleToBasename(long);
    expect(basename.length).toBeLessThanOrEqual(83); // 80 + '.md'
  });
});

describe('resolve — rule tree', () => {
  it('explicit pageType wins', () => {
    const d = resolve({ title: 'Anything', pageType: 'project' });
    expect(d.directory).toBe('projects');
    expect(d.kind).toBe('project');
    expect(d.ruleName).toBe('explicit-page-type');
  });

  it('title override wins over explicit pageType', () => {
    const d = resolve(
      { title: 'Daily Sip', pageType: 'concept' },
      { titleOverrides: { 'Daily Sip': 'company' } },
    );
    expect(d.kind).toBe('company');
    expect(d.ruleName).toBe('title-override');
  });

  it('detects dated meetings', () => {
    const d = resolve({ title: '2026-04-10 dom-sync' });
    expect(d.directory).toBe('meetings');
    expect(d.kind).toBe('meeting');
  });

  it('dated + "synthesis" → synthesis not meeting', () => {
    const d = resolve({ title: '2026-04-10 weekly synthesis' });
    expect(d.kind).toBe('synthesis');
  });

  it('detects company suffixes', () => {
    expect(resolve({ title: 'Acme Inc' }).kind).toBe('company');
    expect(resolve({ title: 'Revive Plus Labs' }).kind).toBe('company');
    expect(resolve({ title: 'Stripe Ltd' }).kind).toBe('company');
  });

  it('detects first-last person names', () => {
    expect(resolve({ title: 'Dom Ingleston' }).kind).toBe('person');
    expect(resolve({ title: 'Maurizio Faerber' }).kind).toBe('person');
  });

  it('does not misclassify "Labs" as person', () => {
    expect(resolve({ title: 'Revive Labs' }).kind).toBe('company');
  });

  it('does not misclassify "X System" / "X Framework" as person', () => {
    // "Finance System", "Pinterest System", "Coaching Business" are
    // classic false positives from the naive first+last regex.
    expect(resolve({ title: 'Finance System' }).kind).not.toBe('person');
    expect(resolve({ title: 'Pinterest System' }).kind).not.toBe('person');
    expect(resolve({ title: 'Coaching Business' }).kind).not.toBe('person');
    expect(resolve({ title: 'Janus Agent' }).kind).not.toBe('person');
  });

  it('keyword hints fire on meeting/deal/project/idea', () => {
    expect(resolve({ title: 'kickoff with dom' }).kind).toBe('meeting');
    expect(resolve({ title: 'refund contract' }).kind).toBe('deal');
    expect(resolve({ title: 'Nightcap MVP launch' }).kind).toBe('project');
    expect(resolve({ title: 'idea for pinterest funnel' }).kind).toBe('idea');
  });

  it('keyword hints fire on writing/personal/household', () => {
    expect(resolve({ title: 'draft of manifesto' }).kind).toBe('writing');
    expect(resolve({ title: 'therapy reflection' }).kind).toBe('personal-note');
    expect(resolve({ title: 'apartment lease renewal' }).kind).toBe(
      'household-item',
    );
  });

  it('falls back to inbox at low confidence', () => {
    const d = resolve({ title: 'random unclassified thing' });
    expect(d.kind).toBe('inbox-item');
    expect(d.confidence).toBeLessThan(0.5);
    expect(d.ruleName).toBe('fallback-inbox');
  });

  it('merges user keywordHints with built-ins', () => {
    const d = resolve(
      { title: 'unusual whatever' },
      { keywordHints: { idea: ['whatever'] } },
    );
    expect(d.kind).toBe('idea');
  });

  it('produces deterministic expectedBasename', () => {
    const d = resolve({ title: 'Dom Ingleston' });
    expect(d.expectedBasename).toBe('dom-ingleston.md');
  });
});
