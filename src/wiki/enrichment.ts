/**
 * Dream-cycle enrichment pipeline — per-entity.
 *
 * Four observable steps per candidate:
 *   1. Tier 0 — pure hygiene: dedup evidence, verify wikilinks, no LLM.
 *   2. Budget check — ask dream-budget whether a Tier 1+ call is allowed.
 *   3. Tier 1 — Haiku enrichment. Produces a TierResult.
 *   4. Shadow write — serialize the proposal into
 *      `.openclaw-wiki/enrichment/<slug>/proposed.md`. NEVER touches
 *      the live page. Janus reviews and applies on next wake.
 *
 * Steps 4 onward from the original 7-step plan (data-source lookups,
 * raw-data archival, cross-reference touch-ups) are deferred — they
 * need external APIs that aren't wired yet. The shadow-file pattern
 * stays the whole discipline.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { extractWikiLinks, getPageTitle } from './markdown.js';
import { vaultPaths } from './paths.js';
import {
  checkDreamBudget,
  DreamBudgetConfig,
  markDreamBlocked,
  recordDreamSpend,
} from './dream-budget.js';
import { runTier1, TIER_USD_ESTIMATE, TierResult } from './tier.js';
import { VaultPageRecord } from './vault-walk.js';

export interface EnrichmentCandidate {
  page: VaultPageRecord;
  reason: string;
}

export interface EnrichmentRunResult {
  candidates: number;
  tier0Applied: number;
  tier1Attempted: number;
  tier1Written: number;
  budgetBlocked: number;
  errors: { page: string; message: string }[];
  durationMs: number;
}

/**
 * Identify candidates for enrichment: pages with <3 claims OR confidence
 * below the threshold. The dream cycle passes these to `enrichPages`.
 */
export function selectThinPages(
  pages: VaultPageRecord[],
  opts: { minClaims?: number; confidenceFloor?: number } = {},
): EnrichmentCandidate[] {
  const minClaims = opts.minClaims ?? 3;
  const confidenceFloor = opts.confidenceFloor ?? 0.5;
  const candidates: EnrichmentCandidate[] = [];
  for (const page of pages) {
    // Only enrich "thing" pages — concept/synthesis/source/report are
    // either too abstract or bridge-owned. This mirrors the same kinds
    // that get timelines.
    if (
      page.kind !== 'entity' &&
      page.kind !== 'person' &&
      page.kind !== 'company' &&
      page.kind !== 'project' &&
      page.kind !== 'deal'
    )
      continue;

    const claims = Array.isArray(page.frontmatter.claims)
      ? page.frontmatter.claims
      : [];
    const confidence =
      typeof page.frontmatter.confidence === 'number'
        ? page.frontmatter.confidence
        : 1;

    if (claims.length < minClaims) {
      candidates.push({
        page,
        reason: `claims=${claims.length} below threshold ${minClaims}`,
      });
      continue;
    }
    if (confidence < confidenceFloor) {
      candidates.push({
        page,
        reason: `confidence=${confidence} below floor ${confidenceFloor}`,
      });
    }
  }
  return candidates;
}

/**
 * Tier 0: cheap hygiene. Currently verifies that every `[[wikilink]]`
 * in the body resolves to a real page and returns the count of dangling
 * refs. Tier 0 does not write — it's informational input to the Tier
 * 1 proposal.
 */
export function runTier0(
  page: VaultPageRecord,
  allPagesByBasename: Map<string, VaultPageRecord>,
): { danglingLinks: string[] } {
  const links = extractWikiLinks(page.body);
  const dangling: string[] = [];
  for (const link of links) {
    if (!allPagesByBasename.has(link.toLowerCase())) {
      dangling.push(link);
    }
  }
  return { danglingLinks: dangling };
}

export interface EnrichPagesInput {
  vaultPath: string;
  pages: VaultPageRecord[];
  candidates: EnrichmentCandidate[];
  budget: DreamBudgetConfig;
  now: Date;
  /** Tier-1 adapter. Defaults to the real Haiku call. Tests inject a stub. */
  tier1?: typeof runTier1;
}

/**
 * Run the per-candidate pipeline: Tier 0 hygiene → budget check →
 * Tier 1 LLM call → shadow write. Mutates dream-budget state on disk.
 * Never touches live pages.
 */
export async function enrichPages(
  input: EnrichPagesInput,
): Promise<EnrichmentRunResult> {
  const startedAt = Date.now();
  const tier1Fn = input.tier1 ?? runTier1;
  const result: EnrichmentRunResult = {
    candidates: input.candidates.length,
    tier0Applied: 0,
    tier1Attempted: 0,
    tier1Written: 0,
    budgetBlocked: 0,
    errors: [],
    durationMs: 0,
  };

  const pagesByBasename = new Map<string, VaultPageRecord>();
  for (const p of input.pages) pagesByBasename.set(p.basename, p);

  for (const candidate of input.candidates) {
    try {
      // Step 1: Tier 0 hygiene. Free, runs unconditionally.
      const tier0 = runTier0(candidate.page, pagesByBasename);
      result.tier0Applied++;

      // Step 2: Budget check before any LLM call.
      const check = checkDreamBudget(
        input.vaultPath,
        1,
        input.budget,
        input.now,
      );
      if (!check.allowed) {
        result.budgetBlocked++;
        markDreamBlocked(
          input.vaultPath,
          check.reason ?? 'dream budget exhausted',
          check.state,
        );
        // Once we've hit the cap, every remaining candidate would
        // re-read the budget file and re-block. Stop iterating.
        break;
      }

      // Step 3: Tier 1 LLM. Adapter returns an empty result on any
      // failure — we still write a shadow file so Janus sees the
      // attempt and its outcome.
      result.tier1Attempted++;
      const neighbours = selectNeighbours(candidate.page, input.pages);
      const tierResult = await tier1Fn({
        pageTitle: candidate.page.frontmatter.title ?? candidate.page.basename,
        pageKind: candidate.page.kind ?? 'unknown',
        existingBody: candidate.page.body,
        existingClaims: Array.isArray(candidate.page.frontmatter.claims)
          ? candidate.page.frontmatter.claims
          : [],
        neighbours,
      });

      recordDreamSpend(
        input.vaultPath,
        1,
        TIER_USD_ESTIMATE[1],
        check.state,
        input.now,
        input.budget.tz,
      );

      // Step 4: Shadow write. Never mutates the live page.
      writeShadowProposal({
        vaultPath: input.vaultPath,
        page: candidate.page,
        reason: candidate.reason,
        tier0,
        tierResult,
      });
      result.tier1Written++;
    } catch (err) {
      result.errors.push({
        page: candidate.page.relativePath,
        message: (err as Error).message,
      });
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

// =============================================================================
// Shadow proposal writer
// =============================================================================

function writeShadowProposal(params: {
  vaultPath: string;
  page: VaultPageRecord;
  reason: string;
  tier0: { danglingLinks: string[] };
  tierResult: TierResult;
}): void {
  const slug = params.page.basename;
  const dir = path.join(
    vaultPaths(params.vaultPath).stateDir,
    'enrichment',
    slug,
  );
  fs.mkdirSync(dir, { recursive: true });
  const proposedPath = path.join(dir, 'proposed.md');

  const lines: string[] = [];
  lines.push(
    `# Enrichment proposal for ${params.page.frontmatter.title ?? slug}`,
  );
  lines.push('');
  lines.push(
    `_Generated at ${new Date().toISOString()} by tier-${params.tierResult.tier} dream cycle. Review and apply manually._`,
  );
  lines.push('');
  lines.push(`**Candidate reason:** ${params.reason}`);
  lines.push(`**Source page:** \`${params.page.relativePath}\``);
  lines.push('');

  if (params.tier0.danglingLinks.length > 0) {
    lines.push('## Tier 0 — hygiene');
    lines.push('');
    lines.push('Dangling wikilinks (no matching basename in vault):');
    for (const link of params.tier0.danglingLinks) {
      lines.push(`- \`[[${link}]]\``);
    }
    lines.push('');
  }

  lines.push('## Tier 1 — proposed enrichment');
  lines.push('');
  if (params.tierResult.summary) {
    lines.push('### Summary');
    lines.push('');
    lines.push(params.tierResult.summary);
    lines.push('');
  }
  if (params.tierResult.proposedClaims.length > 0) {
    lines.push('### Proposed claims');
    lines.push('');
    for (const claim of params.tierResult.proposedClaims) {
      lines.push(`- ${claim}`);
    }
    lines.push('');
  }
  if (params.tierResult.suggestedLinks.length > 0) {
    lines.push('### Suggested cross-links');
    lines.push('');
    for (const link of params.tierResult.suggestedLinks) {
      lines.push(`- [[${link}]]`);
    }
    lines.push('');
  }
  if (params.tierResult.contradictions.length > 0) {
    lines.push('### Contradictions flagged');
    lines.push('');
    for (const c of params.tierResult.contradictions) {
      lines.push(`- ${c}`);
    }
    lines.push('');
  }
  if (params.tierResult.questions.length > 0) {
    lines.push('### Research questions');
    lines.push('');
    for (const q of params.tierResult.questions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  atomicWriteFile(proposedPath, lines.join('\n'));
}

// =============================================================================
// Neighbour selection
// =============================================================================

/**
 * Pick up to 30 nearby pages by shared wikilinks + same-directory
 * locality. Feeds the Tier 1 prompt so the LLM can suggest real
 * cross-links instead of hallucinating basenames.
 */
function selectNeighbours(
  page: VaultPageRecord,
  all: VaultPageRecord[],
): { title: string; kind: string }[] {
  const out: { title: string; kind: string }[] = [];
  const linkedBasenames = new Set(
    extractWikiLinks(page.body).map((l) => l.toLowerCase()),
  );
  // Priority 1: pages this page already links to.
  for (const p of all) {
    if (p.filePath === page.filePath) continue;
    if (linkedBasenames.has(p.basename)) {
      out.push({
        title: getPageTitle(p.frontmatter, p.basename),
        kind: p.kind ?? 'unknown',
      });
    }
    if (out.length >= 30) break;
  }
  // Priority 2: other pages in the same directory.
  if (out.length < 30) {
    for (const p of all) {
      if (p.filePath === page.filePath) continue;
      if (p.dir !== page.dir) continue;
      if (linkedBasenames.has(p.basename)) continue; // already added
      out.push({
        title: getPageTitle(p.frontmatter, p.basename),
        kind: p.kind ?? 'unknown',
      });
      if (out.length >= 30) break;
    }
  }
  return out;
}
