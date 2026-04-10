import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeBridgeConfig } from './bridge-config.js';
import { buildRow, enqueueMessage } from './entity-queue.js';
import {
  groupRowsIntoWindows,
  LlmAdapter,
  LlmExtractionResult,
  prefilterWindow,
  readCandidates,
  runEntityScan,
} from './entity-scan.js';

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-entity-scan-'));
  fs.mkdirSync(path.join(dir, '.openclaw-wiki'), { recursive: true });
  return dir;
}

describe('groupRowsIntoWindows', () => {
  it('returns no closed windows for empty input', () => {
    const r = groupRowsIntoWindows([], 60, 10, new Date());
    expect(r.closed).toEqual([]);
    expect(r.open).toEqual([]);
  });

  it('groups consecutive rows within idle gap into one window', () => {
    const base = new Date('2026-04-10T10:00:00Z').getTime();
    const rows = [
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet: 'hi',
        ts: new Date(base),
      }),
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet: 'how are you',
        ts: new Date(base + 10_000),
      }),
    ];
    // "Now" is 5 minutes after last row → window should be closed (idle)
    const now = new Date(base + 5 * 60 * 1000);
    const { closed, open } = groupRowsIntoWindows(rows, 60, 10, now);
    expect(closed).toHaveLength(1);
    expect(closed[0].rows).toHaveLength(2);
    expect(open).toEqual([]);
  });

  it('splits windows at the idle boundary', () => {
    const base = new Date('2026-04-10T10:00:00Z').getTime();
    const rows = [
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet: 'a',
        ts: new Date(base),
      }),
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet: 'b',
        ts: new Date(base + 5 * 60_000), // 5 min later — past 60s gap
      }),
    ];
    const now = new Date(base + 10 * 60 * 1000);
    const { closed } = groupRowsIntoWindows(rows, 60, 10, now);
    expect(closed).toHaveLength(2);
  });

  it('hard-flushes at max messages', () => {
    const base = new Date('2026-04-10T10:00:00Z').getTime();
    const rows = Array.from({ length: 12 }, (_, i) =>
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet: `msg ${i}`,
        ts: new Date(base + i * 1000),
      }),
    );
    const now = new Date(base + 20 * 60 * 1000);
    const { closed } = groupRowsIntoWindows(rows, 60, 10, now);
    // 12 messages, cap 10 → first window = 10, second window = 2
    expect(closed).toHaveLength(2);
    expect(closed[0].rows).toHaveLength(10);
    expect(closed[1].rows).toHaveLength(2);
  });

  it('keeps recent rows (< idleSeconds) open', () => {
    const now = new Date('2026-04-10T10:00:00Z');
    const row = buildRow({
      groupFolder: 'g',
      chatJid: 'c',
      sender: 'user',
      snippet: 'recent',
      ts: new Date(now.getTime() - 10_000),
    });
    const { closed, open } = groupRowsIntoWindows([row], 60, 10, now);
    expect(closed).toEqual([]);
    expect(open).toHaveLength(1);
  });

  it('does not merge rows from different chats', () => {
    const base = new Date('2026-04-10T10:00:00Z').getTime();
    const rows = [
      buildRow({
        groupFolder: 'g',
        chatJid: 'chat-a',
        sender: 'user',
        snippet: 'hi from chat a',
        ts: new Date(base),
      }),
      buildRow({
        groupFolder: 'g',
        chatJid: 'chat-b',
        sender: 'user',
        snippet: 'hi from chat b',
        ts: new Date(base + 1000),
      }),
    ];
    const now = new Date(base + 5 * 60_000);
    const { closed } = groupRowsIntoWindows(rows, 60, 10, now);
    expect(closed).toHaveLength(2);
  });
});

describe('prefilterWindow', () => {
  function windowOf(text: string) {
    return {
      windowId: 'w',
      groupFolder: 'g',
      chatJid: 'c',
      openedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      rows: [
        {
          ts: new Date().toISOString(),
          groupFolder: 'g',
          chatJid: 'c',
          messageId: 'm',
          sender: 'user',
          snippet: text,
        },
      ],
      text: `user: ${text}`,
    };
  }

  it('rejects short text', () => {
    expect(prefilterWindow(windowOf('hi there')).accept).toBe(false);
  });

  it('rejects stopword-only exchanges', () => {
    expect(prefilterWindow(windowOf('ok thx lol yes sure bye')).accept).toBe(
      false,
    );
  });

  it('rejects text with zero capitalized tokens', () => {
    expect(
      prefilterWindow(
        windowOf(
          'the quick brown fox jumped over the lazy dog many many many times',
        ),
      ).accept,
    ).toBe(false);
  });

  it('accepts substantive text with a proper noun', () => {
    expect(
      prefilterWindow(
        windowOf(
          'talked with Dom about the Klaviyo welcome series, he wants to A/B test the subject line',
        ),
      ).accept,
    ).toBe(true);
  });
});

describe('runEntityScan end-to-end', () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('no-ops when entityScan disabled', async () => {
    const result = await runEntityScan(vault, {
      now: new Date('2026-04-10T12:00:00Z'),
      skipQuietHours: true,
    });
    expect(result.llmCalls).toBe(0);
  });

  it('runs the full pipeline with a stub adapter', async () => {
    // Enable entity scan
    writeBridgeConfig(vault, {
      vaultMode: 'bridge',
      ingest: { autoCompile: true, autoIngest: true },
      sources: [],
      entityScan: {
        enabled: true,
        dailyBudgetUsd: 5.0,
        windowIdleSeconds: 60,
        windowMaxMessages: 10,
        quietHoursTz: 'Europe/Berlin',
        quietHoursStart: 23,
        quietHoursEnd: 7,
      },
    });

    // Enqueue two rows forming one conversation window
    const base = new Date('2026-04-10T12:00:00Z').getTime();
    enqueueMessage(
      vault,
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet:
          'talked with Dom Ingleston about the Klaviyo welcome series, he wants to A/B test the subject line',
        ts: new Date(base),
      }),
    );
    enqueueMessage(
      vault,
      buildRow({
        groupFolder: 'g',
        chatJid: 'c',
        sender: 'user',
        snippet:
          'I really think the whole retention funnel is upside down — nobody starts from the welcome flow',
        ts: new Date(base + 5_000),
      }),
    );

    const stub: LlmAdapter = {
      async extract(text: string): Promise<LlmExtractionResult> {
        return {
          entities: [
            {
              name: 'Dom Ingleston',
              type: 'person',
              quote: 'Dom Ingleston',
            },
            { name: 'Klaviyo', type: 'tool', quote: 'Klaviyo' },
            {
              name: 'Nonexistent',
              type: 'company',
              quote: 'this quote is not in the text',
            },
          ],
          originals: [
            {
              quote: 'I really think the whole retention funnel is upside down',
            },
          ],
        };
      },
    };

    const now = new Date(base + 5 * 60_000); // 5 min after last msg → closed
    const result = await runEntityScan(vault, {
      adapter: stub,
      now,
      skipQuietHours: true,
    });

    expect(result.windowsProcessed).toBe(1);
    expect(result.entitiesExtracted).toBe(2); // "Nonexistent" filtered out
    expect(result.originalsExtracted).toBe(1);
    expect(result.llmCalls).toBe(1);

    const candidates = readCandidates(vault);
    expect(candidates.map((c) => c.name)).toEqual([
      'Dom Ingleston',
      'Klaviyo',
      '', // original-thinking has empty name
    ]);
    expect(candidates.some((c) => c.kind === 'original-thinking')).toBe(true);
  });
});
