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
import {
  runTier1,
  runTier2,
  runTier3,
  TIER_USD_ESTIMATE,
  TierResult,
  TierPromptContext,
  EnrichmentTier,
} from './tier.js';
import { VaultPageRecord } from './vault-walk.js';

export interface EnrichmentCandidate {
  page: VaultPageRecord;
  reason: string;
}

// =============================================================================
// Auto-escalation — Tier 2 fires automatically on thin important pages
// and on pages with known contradictions, without human intervention.
// =============================================================================

const TIER2_LOAD_BEARING_KINDS = new Set([
  'person',
  'company',
  'project',
  'deal',
]);

function shouldEscalateToTier2(
  vaultPath: string,
  page: VaultPageRecord,
): boolean {
  // a) explicit opt-in
  if (page.frontmatter.enrichmentTier === 2) return true;

  // b) thin important page
  if (TIER2_LOAD_BEARING_KINDS.has(page.kind ?? '')) {
    const claims = Array.isArray(page.frontmatter.claims)
      ? page.frontmatter.claims
      : [];
    if (claims.length < 3) return true;
  }

  // c) prior-run contradiction signal
  return readEscalationSignal(vaultPath, page.basename);
}

function escalationPath(vaultPath: string, basename: string): string {
  return path.join(
    vaultPaths(vaultPath).stateDir,
    'enrichment',
    basename,
    'escalate.json',
  );
}

function readEscalationSignal(vaultPath: string, basename: string): boolean {
  const p = escalationPath(vaultPath, basename);
  if (!fs.existsSync(p)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      contradictions?: number;
      clearedAt?: string;
    };
    if (raw.clearedAt) return false;
    return (raw.contradictions ?? 0) > 0;
  } catch {
    return false;
  }
}

function recordEscalationSignal(
  vaultPath: string,
  basename: string,
  contradictions: number,
): void {
  const p = escalationPath(vaultPath, basename);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteFile(
    p,
    JSON.stringify(
      { contradictions, loggedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
}

export interface EnrichmentRunResult {
  candidates: number;
  tier0Applied: number;
  tier1Attempted: number;
  tier1Written: number;
  tier2Attempted: number;
  tier2Written: number;
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
  /** Tier-2 adapter. Defaults to the real Sonnet call. */
  tier2?: typeof runTier2;
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
  const tier2Fn = input.tier2 ?? runTier2;
  const result: EnrichmentRunResult = {
    candidates: input.candidates.length,
    tier0Applied: 0,
    tier1Attempted: 0,
    tier1Written: 0,
    tier2Attempted: 0,
    tier2Written: 0,
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

      // Auto-escalation to Tier 2 (philosophy: automation is the default).
      // A page gets Sonnet instead of Haiku when any of:
      //   a) explicit opt-in via frontmatter `enrichmentTier: 2`
      //   b) it's a load-bearing kind (person/company/project/deal) with
      //      fewer than 3 claims — thin important pages deserve the
      //      deeper pass
      //   c) a prior dream cycle flagged contradictions on this page
      //      (stored in .openclaw-wiki/enrichment/<slug>/escalate.json)
      const requestedTier: EnrichmentTier = shouldEscalateToTier2(
        input.vaultPath,
        candidate.page,
      )
        ? 2
        : 1;

      // Step 2: Budget check before any LLM call.
      const check = checkDreamBudget(
        input.vaultPath,
        requestedTier,
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

      // Step 3: LLM call at the requested tier. Adapter returns an empty
      // result on any failure — we still write a shadow file so Janus
      // sees the attempt and its outcome.
      const neighbours = selectNeighbours(candidate.page, input.pages);
      const ctx: TierPromptContext = {
        pageTitle: candidate.page.frontmatter.title ?? candidate.page.basename,
        pageKind: candidate.page.kind ?? 'unknown',
        existingBody: candidate.page.body,
        existingClaims: Array.isArray(candidate.page.frontmatter.claims)
          ? candidate.page.frontmatter.claims
          : [],
        neighbours,
      };

      let tierResult: TierResult;
      if (requestedTier === 2) {
        result.tier2Attempted++;
        tierResult = await tier2Fn(ctx);
      } else {
        result.tier1Attempted++;
        tierResult = await tier1Fn(ctx);
      }

      recordDreamSpend(
        input.vaultPath,
        requestedTier as EnrichmentTier,
        TIER_USD_ESTIMATE[requestedTier as EnrichmentTier],
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
      if (requestedTier === 2) result.tier2Written++;
      else result.tier1Written++;

      // Record contradictions as an escalation signal for the next run.
      // Pages with any contradiction found by Tier 1 jump to Tier 2 next
      // time without needing a human to edit frontmatter.
      if (tierResult.contradictions.length > 0) {
        recordEscalationSignal(
          input.vaultPath,
          candidate.page.basename,
          tierResult.contradictions.length,
        );
      }
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

  lines.push(`## Tier ${params.tierResult.tier} — proposed enrichment`);
  lines.push('');
  if (params.tierResult.summary) {
    lines.push('### Summary');
    lines.push('');
    lines.push(params.tierResult.summary);
    lines.push('');
  }
  if (params.tierResult.compiledTruth) {
    lines.push('### Compiled truth (proposed)');
    lines.push('');
    lines.push(params.tierResult.compiledTruth);
    lines.push('');
  }
  if (params.tierResult.dossier) {
    lines.push('### Dossier');
    lines.push('');
    for (const [heading, body] of Object.entries(params.tierResult.dossier)) {
      lines.push(`#### ${heading}`);
      lines.push('');
      lines.push(body);
      lines.push('');
    }
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
// Tier 3 weekly sweep — auto-runs on pages opted in via
// `enrichmentTier: 3`. Invoked from the dream cycle on Sundays (or
// manually via `wiki enrich-weekly`). Reuses the shadow-file writer
// and dream-budget ledger so nothing special needs wiring.
// =============================================================================

export interface Tier3SweepResult {
  attempted: number;
  written: number;
  budgetBlocked: number;
  errors: { page: string; message: string }[];
}

export async function runTier3Weekly(input: {
  vaultPath: string;
  pages: VaultPageRecord[];
  budget: DreamBudgetConfig;
  now: Date;
  tier3?: typeof runTier3;
}): Promise<Tier3SweepResult> {
  const tier3Fn = input.tier3 ?? runTier3;
  const result: Tier3SweepResult = {
    attempted: 0,
    written: 0,
    budgetBlocked: 0,
    errors: [],
  };

  const targets = input.pages.filter((p) => p.frontmatter.enrichmentTier === 3);
  if (targets.length === 0) return result;

  const pagesByBasename = new Map<string, VaultPageRecord>();
  for (const p of input.pages) pagesByBasename.set(p.basename, p);

  for (const page of targets) {
    try {
      const check = checkDreamBudget(
        input.vaultPath,
        3,
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
        break;
      }

      result.attempted++;
      const tier0 = runTier0(page, pagesByBasename);
      const neighbours = selectNeighbours(page, input.pages);
      const tierResult = await tier3Fn({
        pageTitle: page.frontmatter.title ?? page.basename,
        pageKind: page.kind ?? 'unknown',
        existingBody: page.body,
        existingClaims: Array.isArray(page.frontmatter.claims)
          ? page.frontmatter.claims
          : [],
        neighbours,
      });

      recordDreamSpend(
        input.vaultPath,
        3,
        TIER_USD_ESTIMATE[3],
        check.state,
        input.now,
        input.budget.tz,
      );

      writeShadowProposal({
        vaultPath: input.vaultPath,
        page,
        reason: 'weekly tier-3 dossier sweep',
        tier0,
        tierResult,
      });
      result.written++;
    } catch (err) {
      result.errors.push({
        page: page.relativePath,
        message: (err as Error).message,
      });
    }
  }

  return result;
}

// =============================================================================
// Manual tier entry point — invoked by `wiki enrich --tier <N> <slug>`.
// =============================================================================

export interface ManualEnrichInput {
  vaultPath: string;
  slug: string;
  tier: EnrichmentTier;
  pages: VaultPageRecord[];
  budget: DreamBudgetConfig;
  now: Date;
  tier1?: typeof runTier1;
  tier2?: typeof runTier2;
  tier3?: typeof runTier3;
}

export interface ManualEnrichResult {
  tier: EnrichmentTier;
  proposedPath: string;
  budgetBlocked: boolean;
  reason?: string;
}

/**
 * Manual one-shot enrichment for a single page. Used by the CLI when the
 * user wants a deep dossier (tier 3) or an on-demand tier-2 rewrite
 * outside the nightly dream cycle. Always writes a shadow proposal —
 * never mutates the live page.
 */
export async function enrichPageManually(
  input: ManualEnrichInput,
): Promise<ManualEnrichResult> {
  const page = input.pages.find(
    (p) => p.basename === input.slug || p.frontmatter.id === input.slug,
  );
  if (!page) {
    throw new Error(
      `enrichPageManually: no page found for slug "${input.slug}"`,
    );
  }

  const check = checkDreamBudget(
    input.vaultPath,
    input.tier,
    input.budget,
    input.now,
  );
  if (!check.allowed) {
    markDreamBlocked(
      input.vaultPath,
      check.reason ?? 'dream budget exhausted',
      check.state,
    );
    return {
      tier: input.tier,
      proposedPath: '',
      budgetBlocked: true,
      reason: check.reason,
    };
  }

  const pagesByBasename = new Map<string, VaultPageRecord>();
  for (const p of input.pages) pagesByBasename.set(p.basename, p);
  const tier0 = runTier0(page, pagesByBasename);
  const neighbours = selectNeighbours(page, input.pages);

  const ctx: TierPromptContext = {
    pageTitle: page.frontmatter.title ?? page.basename,
    pageKind: page.kind ?? 'unknown',
    existingBody: page.body,
    existingClaims: Array.isArray(page.frontmatter.claims)
      ? page.frontmatter.claims
      : [],
    neighbours,
  };

  const tier1Fn = input.tier1 ?? runTier1;
  const tier2Fn = input.tier2 ?? runTier2;
  const tier3Fn = input.tier3 ?? runTier3;

  let tierResult: TierResult;
  if (input.tier === 3) tierResult = await tier3Fn(ctx);
  else if (input.tier === 2) tierResult = await tier2Fn(ctx);
  else if (input.tier === 1) tierResult = await tier1Fn(ctx);
  else
    throw new Error(
      `enrichPageManually: tier 0 is hygiene-only; use tier 1/2/3`,
    );

  recordDreamSpend(
    input.vaultPath,
    input.tier,
    TIER_USD_ESTIMATE[input.tier],
    check.state,
    input.now,
    input.budget.tz,
  );

  writeShadowProposal({
    vaultPath: input.vaultPath,
    page,
    reason: `manual tier-${input.tier} enrich`,
    tier0,
    tierResult,
  });

  const proposedPath = path.join(
    vaultPaths(input.vaultPath).stateDir,
    'enrichment',
    page.basename,
    'proposed.md',
  );
  return { tier: input.tier, proposedPath, budgetBlocked: false };
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
