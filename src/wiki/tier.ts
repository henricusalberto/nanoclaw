/**
 * Dream-cycle enrichment tiers.
 *
 * Tier 0 — pure, zero-cost. Backfill provenance, dedup evidence, verify
 * wikilinks. Runs unconditionally on every dream-cycle pass.
 *
 * Tier 1 — Haiku-class, ~1k tokens/entity. Default for thin or
 * newly-observed entities. Generates a 3-sentence summary, 3 key
 * claims, 5 cross-link suggestions. Shadow-file output.
 *
 * Tier 2 — Sonnet-class, ~5k tokens/entity. Opt-in via frontmatter
 * `enrichmentTier: 2`. Rewrites compiled-truth section, surfaces
 * contradictions, proposes 2 research questions. Shadow-file output.
 *
 * Tier 3 — Opus-class, ~15k tokens/entity. Manual only via
 * `wiki enrich --tier 3 <slug>`. Full deep dossier.
 *
 * Every call above tier 0 charges the dream-budget ledger BEFORE the
 * LLM request so a mid-flight crash never leaves the ledger behind.
 */

import { logger } from '../logger.js';

import { callClaudeCli } from './extractors/claude-cli.js';

export type EnrichmentTier = 0 | 1 | 2 | 3;

export const TIER_MODEL: Record<EnrichmentTier, string | null> = {
  0: null, // pure — no model
  1: 'claude-haiku-4-5',
  2: 'claude-sonnet-4-5',
  3: 'claude-opus-4-6',
};

/**
 * Conservative cost-per-call estimates in USD. Used by the dream-budget
 * pre-check before an LLM call fires. Real accounting still happens in
 * `recordSpend` post-call.
 */
export const TIER_USD_ESTIMATE: Record<EnrichmentTier, number> = {
  0: 0,
  1: 0.003, // ~1k in + ~500 out @ Haiku rates
  2: 0.05, // ~5k in + ~2k out @ Sonnet rates
  3: 0.3, // ~15k in + ~5k out @ Opus rates
};

export interface TierPromptContext {
  pageTitle: string;
  pageKind: string;
  existingBody: string;
  existingClaims: unknown[];
  neighbours: { title: string; kind: string }[];
}

export interface TierResult {
  tier: EnrichmentTier;
  /** Proposed 3-sentence summary. */
  summary: string;
  /** Short claim sentences the LLM asserts are supported by the body. */
  proposedClaims: string[];
  /** Basenames of pages the LLM suggests cross-linking. */
  suggestedLinks: string[];
  /** Hard flags or contradictions worth human attention. */
  contradictions: string[];
  /** Research questions to pose back to the user. */
  questions: string[];
}

const EMPTY_RESULT = (tier: EnrichmentTier): TierResult => ({
  tier,
  summary: '',
  proposedClaims: [],
  suggestedLinks: [],
  contradictions: [],
  questions: [],
});

const TIER1_PROMPT = `You are enriching a single page in a personal wiki. The user has shared the page body and a list of neighbouring pages. Return a JSON object with exactly these fields:
{
  "summary": "3-sentence summary in the user's voice",
  "proposedClaims": ["up to 3 short factual claims drawn directly from the body"],
  "suggestedLinks": ["up to 5 basename strings from the neighbours list"],
  "contradictions": ["any internal contradictions you notice; empty array if none"],
  "questions": ["up to 2 research questions worth posing back"]
}
Return ONLY the JSON object, no prose, no code fence.`;

const TIER1_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    proposedClaims: { type: 'array', items: { type: 'string' } },
    suggestedLinks: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'proposedClaims', 'suggestedLinks'],
};

/**
 * Tier 1 entry point. Dispatches to the Haiku CLI via `callClaudeCli`.
 * Any failure (timeout, non-zero exit, unparseable JSON) collapses to
 * an empty result — the dream cycle moves on to the next entity.
 */
export async function runTier1(ctx: TierPromptContext): Promise<TierResult> {
  const prompt = [
    TIER1_PROMPT,
    '',
    `# Page: ${ctx.pageTitle} (${ctx.pageKind})`,
    '',
    '## Body',
    ctx.existingBody.slice(0, 8000), // cap input — Haiku context is fine but prompts are paid per token
    '',
    '## Neighbours',
    ctx.neighbours
      .slice(0, 30)
      .map((n) => `- ${n.title} (${n.kind})`)
      .join('\n'),
  ].join('\n');

  try {
    const { json } = await callClaudeCli({
      prompt,
      model: TIER_MODEL[1] ?? 'claude-haiku-4-5',
      jsonSchema: TIER1_SCHEMA,
      timeoutMs: 60_000,
    });
    const parsed = (json ?? {}) as Partial<TierResult>;
    return {
      tier: 1,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      proposedClaims: Array.isArray(parsed.proposedClaims)
        ? parsed.proposedClaims.filter(
            (c): c is string => typeof c === 'string',
          )
        : [],
      suggestedLinks: Array.isArray(parsed.suggestedLinks)
        ? parsed.suggestedLinks.filter(
            (l): l is string => typeof l === 'string',
          )
        : [],
      contradictions: Array.isArray(parsed.contradictions)
        ? parsed.contradictions.filter(
            (c): c is string => typeof c === 'string',
          )
        : [],
      questions: Array.isArray(parsed.questions)
        ? parsed.questions.filter((q): q is string => typeof q === 'string')
        : [],
    };
  } catch (err) {
    logger.warn(
      { err: String(err), page: ctx.pageTitle },
      'dream-cycle: tier-1 call failed',
    );
    return EMPTY_RESULT(1);
  }
}
