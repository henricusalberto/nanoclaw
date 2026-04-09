/**
 * Claim and page freshness assessment.
 *
 * Direct port of OpenClaw's `extensions/memory-wiki/src/claim-health.ts`.
 * Same constants, same status vocabulary, same freshness rank.
 */

import { WikiClaim } from './markdown.js';

export const WIKI_AGING_DAYS = 30;
export const WIKI_STALE_DAYS = 90;

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'unknown';

export const CONTESTED_STATUSES = new Set([
  'contested',
  'contradicted',
  'refuted',
  'superseded',
]);

const FRESHNESS_RANK: Record<FreshnessLevel, number> = {
  fresh: 3,
  aging: 2,
  stale: 1,
  unknown: 0,
};

export function freshnessRank(level: FreshnessLevel): number {
  return FRESHNESS_RANK[level];
}

function daysSince(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.floor((now - ts) / (1000 * 60 * 60 * 24));
}

export function assessPageFreshness(
  updatedAt: string | undefined,
  now: number = Date.now(),
): FreshnessLevel {
  const days = daysSince(updatedAt, now);
  if (days === null) return 'unknown';
  if (days <= WIKI_AGING_DAYS) return 'fresh';
  if (days <= WIKI_STALE_DAYS) return 'aging';
  return 'stale';
}

export function assessClaimFreshness(
  claim: WikiClaim,
  pageUpdatedAt: string | undefined,
  now: number = Date.now(),
): FreshnessLevel {
  // Use the latest of: claim.updatedAt, page.updatedAt, any evidence.updatedAt
  const candidates: string[] = [];
  if (claim.updatedAt) candidates.push(claim.updatedAt);
  if (pageUpdatedAt) candidates.push(pageUpdatedAt);
  for (const e of claim.evidence) {
    if (e.updatedAt) candidates.push(e.updatedAt);
  }
  if (candidates.length === 0) return 'unknown';
  const latest = candidates.reduce((max, c) =>
    Date.parse(c) > Date.parse(max) ? c : max,
  );
  return assessPageFreshness(latest, now);
}

export function isLowConfidence(value: number | undefined): boolean {
  return typeof value === 'number' && value < 0.5;
}

export function isMissingEvidence(claim: WikiClaim): boolean {
  return !claim.evidence || claim.evidence.length === 0;
}

export function isContestedClaim(claim: WikiClaim): boolean {
  return claim.status ? CONTESTED_STATUSES.has(claim.status) : false;
}

export function sortClaims(claims: WikiClaim[]): WikiClaim[] {
  // Sort by (confidence desc, freshness rank desc, text)
  return [...claims].sort((a, b) => {
    const confA = a.confidence ?? 0.5;
    const confB = b.confidence ?? 0.5;
    if (confB !== confA) return confB - confA;
    const freshA = freshnessRank(assessClaimFreshness(a, undefined));
    const freshB = freshnessRank(assessClaimFreshness(b, undefined));
    if (freshB !== freshA) return freshB - freshA;
    return a.text.localeCompare(b.text);
  });
}
