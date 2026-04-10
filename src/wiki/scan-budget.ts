/**
 * Daily-budget ledger for entity scanning.
 *
 * State lives at `<vault>/.openclaw-wiki/scan-budget.json` with the shape:
 *   { date: "YYYY-MM-DD", spentUsd: number, calls: number, blocked?: string }
 *
 * The ledger resets at local midnight (detected by a date field mismatch).
 * All reads/writes go through atomicWriteFile so a crash mid-update never
 * corrupts the ledger — worst case we lose one call's accounting.
 *
 * Pricing: callers supply token counts and the ledger converts with the
 * current Haiku-class rate. No network calls — this is local accounting
 * only, not real-time billing reconciliation.
 */

import path from 'path';

import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import { vaultPaths } from './paths.js';

export interface ScanBudgetState {
  date: string;
  spentUsd: number;
  calls: number;
  blocked?: string;
}

// Claude Haiku 4.5 token prices in USD per 1M tokens (as of 2025-10).
// Conservative — rounded up — so we hit budget caps slightly earlier
// rather than overrunning.
export const HAIKU_INPUT_PER_MTOK = 1.0;
export const HAIKU_OUTPUT_PER_MTOK = 5.0;

function budgetPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'scan-budget.json');
}

function localDateString(now: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now); // "YYYY-MM-DD"
}

export function readBudget(
  vaultPath: string,
  now: Date,
  tz: string,
): ScanBudgetState {
  const file = budgetPath(vaultPath);
  const today = localDateString(now, tz);
  const fallback: ScanBudgetState = { date: today, spentUsd: 0, calls: 0 };
  const state = readJsonOrDefault<ScanBudgetState>(file, fallback);
  if (state.date !== today) {
    return { date: today, spentUsd: 0, calls: 0 };
  }
  return state;
}

export function estimateUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * HAIKU_INPUT_PER_MTOK) / 1_000_000 +
    (outputTokens * HAIKU_OUTPUT_PER_MTOK) / 1_000_000
  );
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: string;
  remainingUsd: number;
  state: ScanBudgetState;
}

/**
 * Check whether another estimated-cost call fits under the cap. Does NOT
 * charge the ledger — call recordSpend() after the LLM call returns to
 * capture actual token usage.
 */
export function checkBudget(
  vaultPath: string,
  capUsd: number,
  estimateUsdCost: number,
  now: Date,
  tz: string,
): BudgetCheck {
  const state = readBudget(vaultPath, now, tz);
  const remaining = Math.max(0, capUsd - state.spentUsd);
  if (state.spentUsd + estimateUsdCost > capUsd) {
    return {
      allowed: false,
      reason: `daily budget exhausted: spent $${state.spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`,
      remainingUsd: remaining,
      state,
    };
  }
  return { allowed: true, remainingUsd: remaining, state };
}

/**
 * Atomically charge `usd` against today's ledger and bump the call counter.
 * If the date rolled over between the last read and this write, starts a
 * fresh ledger.
 */
export function recordSpend(
  vaultPath: string,
  usd: number,
  now: Date,
  tz: string,
): ScanBudgetState {
  const today = localDateString(now, tz);
  const file = budgetPath(vaultPath);
  const existing = readJsonOrDefault<ScanBudgetState>(file, {
    date: today,
    spentUsd: 0,
    calls: 0,
  });
  const base: ScanBudgetState =
    existing.date === today ? existing : { date: today, spentUsd: 0, calls: 0 };
  const next: ScanBudgetState = {
    date: today,
    spentUsd: base.spentUsd + usd,
    calls: base.calls + 1,
  };
  atomicWriteFile(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function markBlocked(
  vaultPath: string,
  reason: string,
  now: Date,
  tz: string,
): void {
  const state = readBudget(vaultPath, now, tz);
  const next: ScanBudgetState = { ...state, blocked: reason };
  atomicWriteFile(budgetPath(vaultPath), JSON.stringify(next, null, 2) + '\n');
}

export function getBudgetPath(vaultPath: string): string {
  return budgetPath(vaultPath);
}
