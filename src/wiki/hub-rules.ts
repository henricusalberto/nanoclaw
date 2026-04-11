/**
 * Hub assignment rules. One source of truth for which hub a page
 * belongs to, used by:
 *
 *   - `backfill-hubs` CLI (one-shot writes hub: to frontmatter)
 *   - future resolver extension (suggests a hub when pages are created)
 *
 * Rules run top-to-bottom; first match wins. If nothing matches, a
 * page gets no hub assignment and stays invisible to the hub
 * projections — which is the right behaviour for pages the author
 * hasn't decided about yet.
 *
 * The table is intentionally explicit rather than pattern-heavy:
 * navigation is a human concern and muscle memory beats clever
 * inference. Edit this file when a new hub-worthy page lands.
 */

import { WikiPageFrontmatter, WikiPageKind } from './markdown.js';

export type HubSlug =
  // Six life-domain hubs — the top-level portal on home.md
  | 'businesses'
  | 'meta-ads'
  | 'playbooks'
  | 'systems'
  | 'people'
  | 'me'
  // Domain-specific hubs for areas Maurizio spends a lot of time on.
  // These appear inside hubs/businesses.md as linked sub-domains, not
  // on the home portal bar.
  | 'pinterest'
  | 'coaching';

export interface HubRuleInput {
  basename: string;
  kind: WikiPageKind | undefined;
  expectedKind: WikiPageKind;
  frontmatter: WikiPageFrontmatter;
}

// =============================================================================
// Explicit basename → hub overrides. Wins over every other rule.
// Keep this alphabetised.
// =============================================================================

const BASENAME_OVERRIDES: Record<string, HubSlug> = {
  // --- meta-ads
  'ad-metrics-framework': 'meta-ads',
  'advertorials-listicles': 'meta-ads',
  'ads-manager': 'meta-ads',
  'articles-as-ads': 'meta-ads',
  'compliance-messaging': 'meta-ads',
  'facebook-ad-algorithm': 'meta-ads',
  'nightcap-copy-framework': 'meta-ads',

  // --- playbooks (Dom's frameworks and general methodology)
  'behavioral-operating-system': 'playbooks',
  'current-state': 'playbooks',
  'ecom-product-development': 'playbooks',
  frameworks: 'playbooks',
  'lessons-learned': 'playbooks',

  // --- systems
  'anthropic-api': 'systems',
  'better-sqlite3': 'systems',
  bentoboi: 'systems',
  calendly: 'systems',
  chrome: 'systems',
  discord: 'systems',
  'evening-shutdown': 'systems',
  fathom: 'systems',
  'fathom-fallback-poll': 'systems',
  'finance-system': 'systems',
  flask: 'systems',
  gemini: 'systems',
  git: 'systems',
  gmail: 'systems',
  gog: 'systems',
  'gog-cli': 'systems',
  'google-calendar': 'systems',
  'hst-erp': 'systems',
  'idle-mode': 'systems',
  'janus-agent': 'systems',
  lcm: 'systems',
  'lcm-3-day-check-in-reminder': 'systems',
  'memory-core': 'systems',
  'memory-wiki': 'systems',
  'meta-api': 'systems',
  'mid-day-check': 'systems',
  'morning-briefing': 'systems',
  new: 'systems',
  nextjs: 'systems',
  'pinterest-pipeline': 'systems',
  'planning-system': 'systems',
  qmd: 'systems',
  'qmd-embedding': 'systems',
  sigusr1: 'systems',
  sonnet: 'systems',
  telegram: 'systems',
  'tools-and-systems': 'systems',
  todoist: 'systems',
  'topic-1291': 'systems',
  vault: 'systems',
  wiki: 'systems',

  // --- businesses (explicitly, beyond the dir default)
  coaching: 'businesses',
  'daily-sip': 'businesses',
  dropshipping: 'businesses',
  'facebook-ads': 'businesses',
  nightcap: 'businesses',
  'pinterest-decision-engine': 'businesses',
  pinterest: 'businesses',
  'pinterest-system': 'businesses',
  'revive-plus-labs': 'businesses',

  // --- me
  adhd: 'me',
  'china-trip': 'me',
  maurizio: 'me',
  'maurizio-faerber': 'me',
};

// =============================================================================
// Directory → hub defaults, applied when no explicit override matches.
// =============================================================================

const KIND_TO_HUB: Partial<Record<WikiPageKind, HubSlug>> = {
  person: 'people',
  company: 'businesses',
  project: 'businesses',
  deal: 'businesses',
  meeting: 'businesses',
  idea: 'businesses',
  synthesis: 'businesses',
  writing: 'me',
  'personal-note': 'me',
  'household-item': 'me',
  // Phase 6 taxonomy: tensions, philosophies, patterns, decisions
  tension: 'me', // inner-life lives on the `me` hub
  philosophy: 'me',
  pattern: 'playbooks', // behavioural cycles are a playbook shape
  decision: 'businesses', // inflection points usually trace to business arcs
  // No default for `concept` — concepts go to a specific hub via the
  // explicit basename overrides or the concept-keyword rules below.
  // Un-curated concepts stay unassigned so the playbooks hub doesn't
  // fill up with every dev-tool note and random thought.
  //
  // source/original/report/inbox-item also intentionally undefined —
  // sources get one via the bookmark classifier; the rest stay out
  // of hub projections.
};

// =============================================================================
// Keyword-based fallback for concepts — catches ad-adjacent pages the
// explicit table missed. Only applies to `concept` kind.
// =============================================================================

const CONCEPT_KEYWORD_RULES: Array<{
  hub: HubSlug;
  keywords: string[];
}> = [
  {
    hub: 'meta-ads',
    keywords: [
      'creative',
      'meta-ad',
      'facebook-ad',
      'facebook-ads',
      'ad-copy',
      'adcopy',
      'ad-creative',
      'copy-framework',
      'ugc',
      'advertorial',
      'listicle',
    ],
  },
  {
    hub: 'systems',
    keywords: [
      'api',
      'cli',
      'cron',
      'database',
      'docker',
      'infrastructure',
      'pipeline',
      'script',
      'sqlite',
      'webhook',
      'agent',
      'json',
      'yaml',
      'cache',
      'env',
      'hook',
      'mcp',
    ],
  },
  {
    hub: 'businesses',
    keywords: [
      'brand',
      'shopify',
      'supplier',
      'fulfillment',
      'product-dev',
      'landing',
      'funnel',
      'd2c',
    ],
  },
  {
    hub: 'me',
    keywords: [
      'adhd',
      'health',
      'travel',
      'philosophy',
      'planning',
      'habit',
      'routine',
      'sleep',
      'energy',
    ],
  },
];

// =============================================================================
// Public entry point
// =============================================================================

export interface ResolveHubOptions {
  /**
   * When true, ignore any pre-existing `hub:` frontmatter and run the
   * rule table from scratch. Used by `backfill-hubs --force` to
   * re-classify every page after the rule table changes.
   */
  ignoreExisting?: boolean;
}

export function resolveHub(
  input: HubRuleInput,
  opts: ResolveHubOptions = {},
): HubSlug | null {
  // 1. Explicit hub on the frontmatter wins (hand-curated or prior run)
  // unless the caller asks us to re-resolve from scratch.
  if (!opts.ignoreExisting) {
    const explicit = input.frontmatter.hub;
    if (typeof explicit === 'string') {
      const trimmed = explicit.trim();
      if (trimmed.length > 0 && isKnownHub(trimmed)) return trimmed as HubSlug;
    }
  }

  // 2. Explicit basename override.
  const override = BASENAME_OVERRIDES[input.basename];
  if (override) return override;

  // 3. Concept-keyword fallback (only for concepts, before the default).
  if (input.expectedKind === 'concept') {
    for (const rule of CONCEPT_KEYWORD_RULES) {
      for (const kw of rule.keywords) {
        if (input.basename.includes(kw)) return rule.hub;
      }
    }
  }

  // 4. Directory / kind default.
  const byKind = KIND_TO_HUB[input.expectedKind];
  if (byKind) return byKind;

  return null;
}

function isKnownHub(s: string): boolean {
  return (
    s === 'businesses' ||
    s === 'meta-ads' ||
    s === 'playbooks' ||
    s === 'systems' ||
    s === 'people' ||
    s === 'me' ||
    s === 'home' ||
    s === 'pinterest' ||
    s === 'coaching'
  );
}
