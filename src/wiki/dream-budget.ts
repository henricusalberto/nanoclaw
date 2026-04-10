/**
 * Daily per-tier budget ledger for the dream cycle.
 *
 * Mirrors scan-budget.ts's shape but tracks one spend bucket per
 * enrichment tier so Haiku and Sonnet caps can drift independently.
 * State lives at `<vault>/.openclaw-wiki/dream-budget.json`.
 *
 * The ledger resets at local midnight (detected by date-field mismatch)
 * and supports the same `blocked` marker scan-budget uses.
 */

import path from 'path';

import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import { vaultPaths } from './paths.js';
import { EnrichmentTier, TIER_USD_ESTIMATE } from './tier.js';

export interface DreamBudgetState {
  date: string;
  /** Spend per tier in USD. Tiers without activity stay at 0. */
  spent: Record<string, number>;
  /** Calls per tier. */
  calls: Record<string, number>;
  /** Set when any tier cap is exceeded; cleared on next midnight reset. */
  blocked?: string;
}

export interface DreamBudgetConfig {
  /** Hard daily caps in USD per tier. Tier 0 is always 0 (pure). */
  capsUsd: Record<EnrichmentTier, number>;
  /** IANA timezone for midnight reset. */
  tz: string;
}

export const DEFAULT_DREAM_BUDGET_CONFIG: DreamBudgetConfig = {
  capsUsd: {
    0: 0,
    1: 1.0,
    2: 2.0,
    3: 0, // Tier 3 is manual only — no automatic cron budget
  },
  tz: 'Europe/Berlin',
};

function budgetPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'dream-budget.json');
}

function localDateString(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

// Hoisted sentinel so readBudget doesn't allocate a fresh fallback per call.
const EMPTY_DREAM_BUDGET: DreamBudgetState = {
  date: '1970-01-01',
  spent: {},
  calls: {},
};

export function readDreamBudget(
  vaultPath: string,
  now: Date,
  tz: string,
): DreamBudgetState {
  const today = localDateString(now, tz);
  const state = readJsonOrDefault<DreamBudgetState>(
    budgetPath(vaultPath),
    EMPTY_DREAM_BUDGET,
  );
  if (state.date !== today) {
    return { date: today, spent: {}, calls: {} };
  }
  return state;
}

export interface DreamBudgetCheck {
  allowed: boolean;
  reason?: string;
  remainingUsd: number;
  state: DreamBudgetState;
}

/**
 * Check whether a tier-N call fits under today's cap. Does NOT mutate
 * the ledger — call `recordDreamSpend` after the LLM call returns.
 */
export function checkDreamBudget(
  vaultPath: string,
  tier: EnrichmentTier,
  config: DreamBudgetConfig,
  now: Date,
): DreamBudgetCheck {
  const state = readDreamBudget(vaultPath, now, config.tz);
  const cap = config.capsUsd[tier];
  const spent = state.spent[String(tier)] ?? 0;
  const remaining = Math.max(0, cap - spent);
  const estimate = TIER_USD_ESTIMATE[tier];
  if (spent + estimate > cap) {
    return {
      allowed: false,
      reason: `tier-${tier} cap reached: spent $${spent.toFixed(4)} of $${cap.toFixed(2)}`,
      remainingUsd: remaining,
      state,
    };
  }
  return { allowed: true, remainingUsd: remaining, state };
}

/**
 * Atomically charge `usd` against the tier's bucket. Caller passes the
 * `baseState` it already read in `checkDreamBudget` so we don't re-read
 * the file per LLM call.
 */
export function recordDreamSpend(
  vaultPath: string,
  tier: EnrichmentTier,
  usd: number,
  baseState: DreamBudgetState,
  now: Date,
  tz: string,
): DreamBudgetState {
  const today = localDateString(now, tz);
  const base: DreamBudgetState =
    baseState.date === today
      ? baseState
      : { date: today, spent: {}, calls: {} };
  const key = String(tier);
  const next: DreamBudgetState = {
    date: today,
    spent: { ...base.spent, [key]: (base.spent[key] ?? 0) + usd },
    calls: { ...base.calls, [key]: (base.calls[key] ?? 0) + 1 },
  };
  atomicWriteFile(budgetPath(vaultPath), JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function markDreamBlocked(
  vaultPath: string,
  reason: string,
  baseState: DreamBudgetState,
): void {
  const next: DreamBudgetState = { ...baseState, blocked: reason };
  atomicWriteFile(budgetPath(vaultPath), JSON.stringify(next, null, 2) + '\n');
}

export function getDreamBudgetPath(vaultPath: string): string {
  return budgetPath(vaultPath);
}
