/**
 * Resolver — "given a title + optional type hint, which directory does
 * this page belong in?" A deterministic rule-based decision tree, no
 * LLM, no I/O. Callable from both the CLI (`wiki resolve`) and the
 * migration script (`wiki migrate-vault`).
 *
 * The rules fire in priority order. First match wins. If nothing fires,
 * the fallback is `inbox/` with low confidence — Janus can curate from
 * there.
 *
 * Configured by `.openclaw-wiki/resolver.json`. Any rule the user
 * overrides layers on top of the built-in defaults.
 */

import fs from 'fs';
import path from 'path';

import { readJsonOrDefault } from './fs-util.js';
import { WikiPageKind } from './markdown.js';
import { vaultPaths } from './paths.js';

/**
 * External hint the caller can pass. `pageType` is the primary signal
 * (comes from a new page's intended kind); `hint` is free-form text the
 * caller observed (e.g., "a meeting with Dom"). Both are optional.
 */
export interface ResolverInput {
  title: string;
  pageType?: WikiPageKind | string;
  hint?: string;
}

export interface ResolverDecision {
  directory: string;
  kind: WikiPageKind;
  expectedBasename: string;
  confidence: number;
  reasoning: string;
  ruleName: string;
}

/**
 * Static mapping from page kind to its MECE directory. The resolver
 * uses this when `pageType` is set explicitly; when `pageType` is
 * missing or ambiguous it falls through to the rule-based inference.
 */
export const KIND_TO_DIR: Record<WikiPageKind, string> = {
  entity: 'entities',
  concept: 'concepts',
  source: 'sources',
  synthesis: 'syntheses',
  report: 'reports',
  original: 'originals',
  person: 'people',
  company: 'companies',
  meeting: 'meetings',
  deal: 'deals',
  project: 'projects',
  idea: 'ideas',
  writing: 'writing',
  'personal-note': 'personal',
  'household-item': 'household',
  'inbox-item': 'inbox',
  hub: 'hubs',
  tension: 'tensions',
  philosophy: 'philosophies',
  pattern: 'patterns',
  decision: 'decisions',
};

/**
 * User-overridable resolver config. Lives at
 * `.openclaw-wiki/resolver.json`. Everything is additive — the built-in
 * rules still run even when this file is absent or empty.
 */
export interface ResolverConfig {
  /**
   * Explicit title → directory pins. Used to lock in edge cases the
   * rule tree can't infer (e.g., "Daily Sip" is a product but also
   * the name of a household drink — user forces it to `companies/`).
   */
  titleOverrides?: Record<string, WikiPageKind>;
  /**
   * Extra keyword hints merged into the built-in rule set. Keyed by
   * page kind so users can add their own vocabulary without editing
   * source.
   */
  keywordHints?: Partial<Record<WikiPageKind, string[]>>;
}

const EMPTY_CONFIG: ResolverConfig = {};

export function getResolverConfigPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'resolver.json');
}

export function readResolverConfig(vaultPath: string): ResolverConfig {
  return readJsonOrDefault<ResolverConfig>(
    getResolverConfigPath(vaultPath),
    EMPTY_CONFIG,
  );
}

// =============================================================================
// Built-in keyword sets. These drive the rule tree when an explicit
// pageType isn't provided. Tuned for Maurizio's vocabulary but generic
// enough to work for anyone — users can extend via resolver.json.
// =============================================================================

const PERSON_TITLE_HINTS = [
  // "first last" pattern — two capitalized words, no business suffixes
  /^[A-Z][a-z]+\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?$/,
];

/**
 * Common nouns that look like surnames under the "First Last"
 * capitalization rule but clearly aren't (e.g., "Finance System" is
 * a concept, not a person). If the second token is in this list, the
 * person-name rule defers.
 */
const PERSON_SECOND_TOKEN_BLOCKLIST = new Set([
  'system',
  'systems',
  'business',
  'framework',
  'method',
  'methodology',
  'playbook',
  'funnel',
  'stack',
  'pipeline',
  'agent',
  'bot',
  'service',
  'platform',
  'protocol',
  'engine',
  'model',
  'algorithm',
  'brand',
  'product',
  'project',
  'program',
  'strategy',
]);

const COMPANY_SUFFIXES = [
  'inc',
  'llc',
  'ltd',
  'limited',
  'gmbh',
  'corp',
  'corporation',
  'co',
  'labs',
  'studios',
  'holdings',
  'ventures',
  'capital',
  'partners',
  'group',
  'ag',
  'bv',
  'sarl',
  'kg',
];

const MEETING_KEYWORDS = [
  'meeting',
  'call',
  'sync',
  '1:1',
  'standup',
  'retro',
  'kickoff',
  'intro',
  'onboarding',
];

const DEAL_KEYWORDS = [
  'deal',
  'contract',
  'agreement',
  'terms',
  'invoice',
  'payment',
  'refund',
  'offer',
  'quote',
  'proposal',
];

const PROJECT_KEYWORDS = [
  'project',
  'v1',
  'v2',
  'mvp',
  'launch',
  'ship',
  'build',
  'implementation',
  'rollout',
];

const IDEA_KEYWORDS = [
  'idea',
  'concept for',
  'what if',
  'maybe',
  'possible',
  'should we',
  'could try',
  'hypothesis',
];

const WRITING_KEYWORDS = [
  'essay',
  'post',
  'blog',
  'draft',
  'manifesto',
  'letter',
  'article',
  'piece',
];

const PERSONAL_KEYWORDS = [
  'journal',
  'diary',
  'reflection',
  'health',
  'therapy',
  'mood',
  'family',
  'grief',
  'memory',
  'dream',
];

const HOUSEHOLD_KEYWORDS = [
  'apartment',
  'house',
  'rent',
  'lease',
  'bill',
  'utility',
  'insurance',
  'repair',
  'grocery',
  'subscription',
];

// Dated-slug detection for meetings: e.g., "2026-04-10 dom-sync" or
// "2026/04/10 meeting with dom".
const DATED_SLUG_RE = /^\d{4}-\d{2}-\d{2}/;

// =============================================================================
// Rules — tried in priority order. Each rule inspects the input and
// either returns a decision or defers. First decision wins.
// =============================================================================

type Rule = (
  input: ResolverInput,
  config: ResolverConfig,
) => ResolverDecision | null;

/** 1. Explicit title override from resolver.json. */
const ruleTitleOverride: Rule = (input, config) => {
  const override = config.titleOverrides?.[input.title];
  if (!override) return null;
  return decide({
    kind: override,
    ruleName: 'title-override',
    reasoning: `resolver.json titleOverrides pinned "${input.title}" to ${override}`,
    confidence: 1,
    title: input.title,
  });
};

/** 2. Caller-provided pageType wins over inference. */
const ruleExplicitPageType: Rule = (input) => {
  if (!input.pageType) return null;
  if (!(input.pageType in KIND_TO_DIR)) return null;
  const kind = input.pageType as WikiPageKind;
  return decide({
    kind,
    ruleName: 'explicit-page-type',
    reasoning: `caller passed pageType=${kind}`,
    confidence: 0.95,
    title: input.title,
  });
};

/** 3. Dated prefix → meeting (or synthesis if the title mentions it). */
const ruleDatedMeeting: Rule = (input) => {
  if (
    !DATED_SLUG_RE.test(input.title) &&
    !DATED_SLUG_RE.test(input.title.replace(/\s+/g, '-'))
  ) {
    return null;
  }
  const lowered = input.title.toLowerCase();
  if (lowered.includes('synthesis') || lowered.includes('summary')) {
    return decide({
      kind: 'synthesis',
      ruleName: 'dated-synthesis',
      reasoning: 'title starts with a date and references synthesis/summary',
      confidence: 0.9,
      title: input.title,
    });
  }
  return decide({
    kind: 'meeting',
    ruleName: 'dated-meeting',
    reasoning: 'title starts with a date (YYYY-MM-DD) → meeting record',
    confidence: 0.85,
    title: input.title,
  });
};

/** 4. Company suffix in title → company. */
const ruleCompanySuffix: Rule = (input) => {
  const tokens = input.title
    .toLowerCase()
    .split(/[\s.,]+/)
    .filter(Boolean);
  const lastTwo = tokens.slice(-2);
  for (const suffix of COMPANY_SUFFIXES) {
    if (lastTwo.includes(suffix)) {
      return decide({
        kind: 'company',
        ruleName: 'company-suffix',
        reasoning: `title ends with known company suffix "${suffix}"`,
        confidence: 0.9,
        title: input.title,
      });
    }
  }
  return null;
};

/** 5. First-last name pattern → person. */
const rulePersonName: Rule = (input) => {
  for (const re of PERSON_TITLE_HINTS) {
    if (!re.test(input.title)) continue;
    const tokens = input.title.split(/\s+/).map((t) => t.toLowerCase());
    const lastToken = tokens[tokens.length - 1] ?? '';
    // Guard: company suffix in tail → company, not person.
    if (COMPANY_SUFFIXES.includes(lastToken)) return null;
    // Guard: "X System" / "X Framework" → not a person.
    if (PERSON_SECOND_TOKEN_BLOCKLIST.has(lastToken)) return null;
    // Second guard: any token anywhere in the blocklist disqualifies
    // (catches "Finance System Engine" and similar 3-token cases).
    if (tokens.some((t) => PERSON_SECOND_TOKEN_BLOCKLIST.has(t))) return null;
    return decide({
      kind: 'person',
      ruleName: 'person-name-pattern',
      reasoning: 'title matches "First Last" capitalization pattern',
      confidence: 0.75,
      title: input.title,
    });
  }
  return null;
};

/** 6. Keyword-based fallback tree. Runs the hint + title through sets. */
const ruleKeywords: Rule = (input, config) => {
  const corpus = `${input.title} ${input.hint ?? ''}`.toLowerCase();
  const merged = (base: string[], extra?: string[]) =>
    extra ? [...base, ...extra.map((s) => s.toLowerCase())] : base;

  const checks: { kind: WikiPageKind; keywords: string[] }[] = [
    {
      kind: 'meeting',
      keywords: merged(MEETING_KEYWORDS, config.keywordHints?.meeting),
    },
    {
      kind: 'deal',
      keywords: merged(DEAL_KEYWORDS, config.keywordHints?.deal),
    },
    {
      kind: 'project',
      keywords: merged(PROJECT_KEYWORDS, config.keywordHints?.project),
    },
    {
      kind: 'idea',
      keywords: merged(IDEA_KEYWORDS, config.keywordHints?.idea),
    },
    {
      kind: 'writing',
      keywords: merged(WRITING_KEYWORDS, config.keywordHints?.writing),
    },
    {
      kind: 'personal-note',
      keywords: merged(
        PERSONAL_KEYWORDS,
        config.keywordHints?.['personal-note'],
      ),
    },
    {
      kind: 'household-item',
      keywords: merged(
        HOUSEHOLD_KEYWORDS,
        config.keywordHints?.['household-item'],
      ),
    },
  ];

  for (const { kind, keywords } of checks) {
    for (const kw of keywords) {
      if (corpus.includes(kw)) {
        return decide({
          kind,
          ruleName: `keyword:${kind}`,
          reasoning: `matched keyword "${kw}" in title/hint`,
          confidence: 0.6,
          title: input.title,
        });
      }
    }
  }
  return null;
};

const RULES: Rule[] = [
  ruleTitleOverride,
  ruleExplicitPageType,
  ruleDatedMeeting,
  ruleCompanySuffix,
  rulePersonName,
  ruleKeywords,
];

/**
 * Run the resolver. Iterates rules in priority order, returning the
 * first non-null decision. Falls back to `inbox/` at low confidence.
 */
export function resolve(
  input: ResolverInput,
  config: ResolverConfig = EMPTY_CONFIG,
): ResolverDecision {
  for (const rule of RULES) {
    const decision = rule(input, config);
    if (decision) return decision;
  }
  return decide({
    kind: 'inbox-item',
    ruleName: 'fallback-inbox',
    reasoning:
      'no rule matched — landing in inbox/ for Janus to curate manually',
    confidence: 0.3,
    title: input.title,
  });
}

/** Convenience helper: resolve using the vault's on-disk config. */
export function resolveForVault(
  vaultPath: string,
  input: ResolverInput,
): ResolverDecision {
  const config = readResolverConfig(vaultPath);
  return resolve(input, config);
}

// =============================================================================
// Helpers
// =============================================================================

function decide(params: {
  kind: WikiPageKind;
  ruleName: string;
  reasoning: string;
  confidence: number;
  title: string;
}): ResolverDecision {
  return {
    directory: KIND_TO_DIR[params.kind],
    kind: params.kind,
    expectedBasename: titleToBasename(params.title),
    confidence: params.confidence,
    reasoning: params.reasoning,
    ruleName: params.ruleName,
  };
}

/**
 * Convert a title to the canonical kebab-case basename used by every
 * wiki page. Matches the convention already enforced by compile/lint.
 */
export function titleToBasename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/['']/g, '')
      .replace(/[^\w\s-]/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) + '.md'
  );
}

/**
 * Ensure all MECE directories exist in the vault. Idempotent. Called
 * once at the start of `wiki migrate-vault` so the migration script
 * can move files without stat-checking every target dir.
 */
export function ensureMeceDirectories(vaultPath: string): void {
  const dirs = new Set(Object.values(KIND_TO_DIR));
  for (const dir of dirs) {
    fs.mkdirSync(path.join(vaultPath, dir), { recursive: true });
  }
}
