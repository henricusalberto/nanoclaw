/**
 * Weekly section proposer.
 *
 * Reads the "Everything else" catch-all bucket on each hub page and
 * asks Sonnet to cluster what's piling up there. When a cluster hits a
 * threshold (default: 15+ bookmarks or 5+ pages clearly on the same
 * theme), the proposer suggests a new sub-section for the hub and
 * writes a shadow proposal at
 * `.openclaw-wiki/enrichment/hubs/<hub>/sections-proposal.md`.
 *
 * The user reviews the proposal and applies it manually via
 * `wiki apply-sections <hub>` (a stub subcommand that reads the
 * proposal and writes the new H3 headers into the hub page + re-runs
 * the classifier to re-route existing bookmarks). Applying is gated
 * behind a daylight review — this module only writes shadow
 * proposals, never live page content.
 *
 * Runs as part of the weekly Sunday dream cycle in `dream-cycle.ts`
 * (once wired in a future commit). Until then, manually invokable via
 * `wiki propose-sections` which isn't built yet either — this module
 * is infrastructure for the next step, not a live runner.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { callClaudeCli } from './extractors/claude-cli.js';
import { checkDreamBudget, DreamBudgetConfig, markDreamBlocked, recordDreamSpend } from './dream-budget.js';
import { parseWikiPage } from './markdown.js';
import { vaultPaths } from './paths.js';
import { TIER_USD_ESTIMATE } from './tier.js';

/** Minimum `everything-else` count at which the proposer fires. */
const PROPOSAL_THRESHOLD_BOOKMARKS = 15;
const PROPOSAL_THRESHOLD_PAGES = 5;

export interface SectionProposerOptions {
  vaultPath: string;
  budget?: DreamBudgetConfig;
  now?: Date;
  /** Test seam. Defaults to the real Sonnet call. */
  llmCall?: typeof callClaudeCli;
  /** When true, only report what would happen — don't call Sonnet. */
  dryRun?: boolean;
}

export interface SectionProposerResult {
  hubsScanned: number;
  hubsAboveThreshold: number;
  proposalsWritten: number;
  budgetBlocked: boolean;
  errors: { hub: string; message: string }[];
}

interface HubSnapshot {
  hubSlug: string;
  hubTitle: string;
  filePath: string;
  everythingElseBookmarks: BookmarkSummary[];
  everythingElsePages: PageSummary[];
  existingSections: string[];
}

interface BookmarkSummary {
  id: string;
  oneLiner: string;
  authorHandle: string;
  priority: number;
}

interface PageSummary {
  slug: string;
  title: string;
  kind: string;
}

// =============================================================================
// Entry point
// =============================================================================

export async function proposeSections(
  opts: SectionProposerOptions,
): Promise<SectionProposerResult> {
  const budget = opts.budget;
  const now = opts.now ?? new Date();
  const llmCall = opts.llmCall ?? callClaudeCli;
  const result: SectionProposerResult = {
    hubsScanned: 0,
    hubsAboveThreshold: 0,
    proposalsWritten: 0,
    budgetBlocked: false,
    errors: [],
  };

  const snapshots = collectHubSnapshots(opts.vaultPath);
  result.hubsScanned = snapshots.length;

  for (const snap of snapshots) {
    if (
      snap.everythingElseBookmarks.length < PROPOSAL_THRESHOLD_BOOKMARKS &&
      snap.everythingElsePages.length < PROPOSAL_THRESHOLD_PAGES
    ) {
      continue;
    }
    result.hubsAboveThreshold++;

    if (opts.dryRun) {
      // Report-only: record what would be proposed, don't call Sonnet.
      writeDryRunMarker(opts.vaultPath, snap);
      result.proposalsWritten++;
      continue;
    }

    if (budget) {
      const check = checkDreamBudget(opts.vaultPath, 2, budget, now);
      if (!check.allowed) {
        result.budgetBlocked = true;
        markDreamBlocked(
          opts.vaultPath,
          check.reason ?? 'tier-2 cap reached during section-proposer',
          check.state,
        );
        break;
      }
    }

    let proposal: SectionProposal | null;
    try {
      proposal = await runSonnetProposer(snap, llmCall);
    } catch (err) {
      result.errors.push({
        hub: snap.hubSlug,
        message: (err as Error).message,
      });
      continue;
    }

    if (!proposal || proposal.newSections.length === 0) continue;

    if (budget) {
      const check = checkDreamBudget(opts.vaultPath, 2, budget, now);
      recordDreamSpend(
        opts.vaultPath,
        2,
        TIER_USD_ESTIMATE[2],
        check.state,
        now,
        budget.tz,
      );
    }

    const proposedPath = writeShadowProposal(opts.vaultPath, snap, proposal);
    result.proposalsWritten++;
    // Log for observability
    console.log(
      `section-proposer: wrote proposal for ${snap.hubSlug} → ${proposedPath}`,
    );
  }

  return result;
}

// =============================================================================
// Hub snapshot collection
// =============================================================================

function collectHubSnapshots(vaultPath: string): HubSnapshot[] {
  const hubsDir = path.join(vaultPath, 'hubs');
  if (!fs.existsSync(hubsDir)) return [];

  const snapshots: HubSnapshot[] = [];
  const hubFiles = fs
    .readdirSync(hubsDir)
    .filter((n) => n.endsWith('.md') && n !== 'index.md');

  for (const name of hubFiles) {
    const hubSlug = path.basename(name, '.md');
    const hubPath = path.join(hubsDir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(hubPath, 'utf-8');
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseWikiPage(raw);
    } catch {
      continue;
    }

    const hubTitle =
      (parsed.frontmatter.title as string | undefined) || hubSlug;
    const existingSections = parseExistingSectionsFromBody(parsed.body);
    const { everythingElseBookmarks, everythingElsePages } =
      collectEverythingElse(vaultPath, hubSlug);

    snapshots.push({
      hubSlug,
      hubTitle,
      filePath: hubPath,
      everythingElseBookmarks,
      everythingElsePages,
      existingSections,
    });
  }
  return snapshots;
}

function parseExistingSectionsFromBody(body: string): string[] {
  // Same slug derivation as classify-bookmarks.ts::loadHubSectionMap
  // and hub-projection.ts::parseDeclaredSectionSlugs. Kept in sync
  // manually; if this drifts, the proposer will suggest sections that
  // don't match the classifier's view.
  const slugs = new Set<string>();
  const re = /^###\s+([^\n]+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const heading = m[1].trim();
    if (!heading || heading.toLowerCase().startsWith('(')) continue;
    const slug = heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug && slug !== 'everything-else') slugs.add(slug);
  }
  return Array.from(slugs);
}

function collectEverythingElse(
  vaultPath: string,
  hubSlug: string,
): { everythingElseBookmarks: BookmarkSummary[]; everythingElsePages: PageSummary[] } {
  const bookmarks: BookmarkSummary[] = [];
  const pages: PageSummary[] = [];

  // Walk sources/ for bookmarks with hub: <slug> + hubSection: everything-else
  const sourcesDir = path.join(vaultPath, 'sources');
  if (fs.existsSync(sourcesDir)) {
    for (const name of fs.readdirSync(sourcesDir)) {
      if (!name.endsWith('.md')) continue;
      const p = path.join(sourcesDir, name);
      let raw: string;
      try {
        raw = fs.readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseWikiPage(raw);
      } catch {
        continue;
      }
      if (parsed.frontmatter.hub !== hubSlug) continue;
      if (parsed.frontmatter.hubSection !== 'everything-else') continue;

      const meta =
        (parsed.frontmatter.extractorMetadata as Record<string, unknown>) ||
        {};
      bookmarks.push({
        id: typeof meta.id === 'string' ? meta.id : name,
        oneLiner:
          typeof parsed.frontmatter.hubOneLiner === 'string'
            ? parsed.frontmatter.hubOneLiner
            : typeof parsed.frontmatter.title === 'string'
              ? parsed.frontmatter.title
              : name,
        authorHandle:
          typeof meta.authorHandle === 'string' ? meta.authorHandle : '',
        priority:
          typeof parsed.frontmatter.hubPriority === 'number'
            ? parsed.frontmatter.hubPriority
            : 0.5,
      });
    }
  }

  // Walk the rest of the vault for concept/project/person/etc pages
  // tagged to this hub with hubSection: everything-else (or missing).
  const otherDirs = [
    'concepts',
    'projects',
    'companies',
    'people',
    'deals',
    'syntheses',
    'tensions',
    'philosophies',
    'patterns',
    'decisions',
  ];
  for (const dir of otherDirs) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const name of fs.readdirSync(dirPath)) {
      if (!name.endsWith('.md') || name === 'index.md') continue;
      const p = path.join(dirPath, name);
      let raw: string;
      try {
        raw = fs.readFileSync(p, 'utf-8');
      } catch {
        continue;
      }
      let parsed;
      try {
        parsed = parseWikiPage(raw);
      } catch {
        continue;
      }
      if (parsed.frontmatter.hub !== hubSlug) continue;
      const section = parsed.frontmatter.hubSection;
      if (section && section !== 'everything-else') continue;
      pages.push({
        slug: path.basename(name, '.md'),
        title:
          typeof parsed.frontmatter.title === 'string'
            ? parsed.frontmatter.title
            : path.basename(name, '.md'),
        kind:
          typeof parsed.frontmatter.pageType === 'string'
            ? parsed.frontmatter.pageType
            : 'unknown',
      });
    }
  }

  // Sort bookmarks by priority desc so the proposer sees the loudest
  // signals first.
  bookmarks.sort((a, b) => b.priority - a.priority);

  return { everythingElseBookmarks: bookmarks, everythingElsePages: pages };
}

// =============================================================================
// Sonnet prompt + parse
// =============================================================================

export interface SectionProposal {
  hubSlug: string;
  reasoning: string;
  newSections: ProposedSection[];
}

export interface ProposedSection {
  heading: string; // human-readable, e.g. "AI creative tools"
  slug: string; // machine form, e.g. "ai-creative-tools"
  rationale: string; // why this cluster deserves its own section
  sampleMembers: string[]; // 3-5 example bookmark IDs or page slugs
  estimatedSize: number; // rough count of items that would move
}

const SECTION_PROPOSER_PROMPT = `You are reviewing a "catch-all" bucket on a personal wiki hub page. The hub has a handful of named sub-sections, plus an "Everything else" bucket that receives any bookmark or page the classifier couldn't confidently place.

Your job: look at what has piled up in Everything else. Are there 1-3 clear clusters that each deserve their own named sub-section? If yes, propose them. If not, say so.

CONSTRAINTS:
  - Conservative default: do NOT propose new sections for vague themes. A proposed section must cover at least 8-10 items that clearly belong together.
  - Max 3 new sections per proposal. If there are more clusters, pick the most valuable.
  - Section headings should be short (2-4 words) and scan-friendly.
  - Slugs are lowercase kebab-case, a-z / 0-9 / hyphens only.
  - Don't duplicate an existing section under a different name — if the user already has "Creative workflow", don't propose "Creative production".
  - Write one sentence of rationale per proposed section explaining why this cluster is distinct from the existing sections.

Return a JSON object with exactly this shape:
{
  "reasoning": "one sentence about what you saw in Everything else",
  "newSections": [
    {
      "heading": "Human Title",
      "slug": "kebab-case-slug",
      "rationale": "why this cluster is distinct and worth its own section",
      "sampleMembers": ["<bookmark id or page slug>", "..."],
      "estimatedSize": 12
    }
  ]
}

If no new sections are warranted (bucket is too small or too scattered), return an empty \`newSections\` array with a reasoning sentence explaining why.

Return ONLY the JSON object, no prose, no code fence.`;

async function runSonnetProposer(
  snap: HubSnapshot,
  llmCall: typeof callClaudeCli,
): Promise<SectionProposal | null> {
  const bookmarkLines = snap.everythingElseBookmarks
    .slice(0, 60)
    .map((b) => `  - [${b.id}] @${b.authorHandle}: ${b.oneLiner}`)
    .join('\n');
  const pageLines = snap.everythingElsePages
    .slice(0, 30)
    .map((p) => `  - [${p.slug}] (${p.kind}) ${p.title}`)
    .join('\n');

  const prompt = [
    SECTION_PROPOSER_PROMPT,
    '',
    `# Hub: ${snap.hubTitle} (${snap.hubSlug})`,
    '',
    '## Existing sub-sections',
    snap.existingSections.length > 0
      ? snap.existingSections.map((s) => `  - ${s}`).join('\n')
      : '  (none yet)',
    '',
    `## Everything else — bookmarks (${snap.everythingElseBookmarks.length} total, showing top 60 by priority)`,
    bookmarkLines || '  (none)',
    '',
    `## Everything else — pages (${snap.everythingElsePages.length} total, showing top 30)`,
    pageLines || '  (none)',
  ].join('\n');

  const { json } = await llmCall({
    prompt,
    model: 'claude-sonnet-4-5',
    timeoutMs: 180_000,
  });

  const parsed = (json ?? {}) as Partial<SectionProposal>;
  if (!parsed || typeof parsed !== 'object') return null;

  const rawSections = Array.isArray(parsed.newSections)
    ? (parsed.newSections as unknown[])
    : [];
  const sections: ProposedSection[] = rawSections
    .filter(
      (s): s is Record<string, unknown> =>
        !!s && typeof s === 'object' && !Array.isArray(s),
    )
    .map((s) => ({
      heading: typeof s.heading === 'string' ? s.heading : '',
      slug: typeof s.slug === 'string' ? s.slug : '',
      rationale: typeof s.rationale === 'string' ? s.rationale : '',
      sampleMembers: Array.isArray(s.sampleMembers)
        ? s.sampleMembers.filter((m): m is string => typeof m === 'string')
        : [],
      estimatedSize:
        typeof s.estimatedSize === 'number' ? s.estimatedSize : 0,
    }))
    .filter((s) => s.heading && s.slug);

  return {
    hubSlug: snap.hubSlug,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    newSections: sections,
  };
}

// =============================================================================
// Shadow proposal writer
// =============================================================================

function writeShadowProposal(
  vaultPath: string,
  snap: HubSnapshot,
  proposal: SectionProposal,
): string {
  const dir = path.join(
    vaultPaths(vaultPath).stateDir,
    'enrichment',
    'hubs',
    snap.hubSlug,
  );
  fs.mkdirSync(dir, { recursive: true });
  const proposedPath = path.join(dir, 'sections-proposal.md');

  const lines: string[] = [];
  lines.push(`# Section proposal for ${snap.hubTitle}`);
  lines.push('');
  lines.push(
    `_Generated at ${new Date().toISOString()}. Review and apply manually with \`wiki apply-sections ${snap.hubSlug}\`._`,
  );
  lines.push('');
  lines.push(`**Hub:** ${snap.hubSlug}`);
  lines.push(
    `**Everything else:** ${snap.everythingElseBookmarks.length} bookmarks + ${snap.everythingElsePages.length} pages`,
  );
  lines.push('');
  lines.push(`**Sonnet's reasoning:** ${proposal.reasoning}`);
  lines.push('');

  if (proposal.newSections.length === 0) {
    lines.push(
      '_No new sections recommended. Everything else bucket is either too small, too scattered, or a good fit for the existing shape._',
    );
  } else {
    lines.push(
      `## Proposed ${proposal.newSections.length} new sub-section${proposal.newSections.length === 1 ? '' : 's'}`,
    );
    lines.push('');
    for (const section of proposal.newSections) {
      lines.push(`### ${section.heading}`);
      lines.push('');
      lines.push(`- **Slug:** \`${section.slug}\``);
      lines.push(`- **Estimated size:** ${section.estimatedSize} items`);
      lines.push(`- **Rationale:** ${section.rationale}`);
      lines.push('');
      if (section.sampleMembers.length > 0) {
        lines.push('**Sample members that would move from Everything else:**');
        for (const m of section.sampleMembers.slice(0, 6)) {
          lines.push(`- \`${m}\``);
        }
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `_To apply: edit \`hubs/${snap.hubSlug}.md\` and add the new H3 headers + matching section-pages/section-try managed blocks. Then run \`wiki classify-bookmarks --apply --reclassify-sections\` to re-route the existing Everything-else items into the new sub-sections._`,
  );

  atomicWriteFile(proposedPath, lines.join('\n'));
  return proposedPath;
}

function writeDryRunMarker(vaultPath: string, snap: HubSnapshot): void {
  const dir = path.join(
    vaultPaths(vaultPath).stateDir,
    'enrichment',
    'hubs',
    snap.hubSlug,
  );
  fs.mkdirSync(dir, { recursive: true });
  const proposedPath = path.join(dir, 'sections-proposal.dryrun.md');
  const body = [
    `# Dry run — ${snap.hubTitle}`,
    '',
    `_Generated at ${new Date().toISOString()} (dry run, no Sonnet call)._`,
    '',
    `Everything else bucket: ${snap.everythingElseBookmarks.length} bookmarks + ${snap.everythingElsePages.length} pages.`,
    '',
    'Above threshold. A real run would call Sonnet to propose new sub-sections.',
  ].join('\n');
  atomicWriteFile(proposedPath, body);
}
