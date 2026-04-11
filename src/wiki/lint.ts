/**
 * Wiki lint — structural health checks.
 *
 * Direct port of OpenClaw's `extensions/memory-wiki/src/lint.ts`. All checks
 * are pure structural — no LLM. The agent runs lint via the CLI, reads the
 * report, and decides what to act on.
 *
 * Output is written to `reports/lint.md` inside a managed block so any
 * surrounding human-authored notes survive.
 */

import fs from 'fs';
import path from 'path';

import {
  assessClaimFreshness,
  assessPageFreshness,
  isContestedClaim,
  isLowConfidence,
  isMissingEvidence,
  WIKI_AGING_DAYS,
  WIKI_STALE_DAYS,
} from './claim-health.js';
import { appendWikiLogEvent } from './log.js';
import {
  extractWikiLinks,
  parseWikiPage,
  replaceManagedBlock,
  WikiClaim,
  WikiPageKind,
} from './markdown.js';
import { vaultPaths } from './paths.js';
import {
  claimHasSourceAttribution,
  extractAllSourceAttributions,
  SOURCE_ATTRIBUTION_RE,
} from './source-attribution.js';
import {
  collectVaultPages,
  loadCollisionBlocklist,
  VAULT_DIRS,
  VaultPageRecord,
} from './vault-walk.js';

// Every recognised page kind — VAULT_DIRS (which excludes report) plus
// report itself. Used by `unknown-page-type` to reject typos or kinds
// that were removed from the union.
const KNOWN_PAGE_KINDS: Set<string> = new Set([
  ...VAULT_DIRS.map((v) => v.kind),
  'report',
]);

export type LintSeverity = 'error' | 'warning' | 'info';

export type LintCheckCode =
  | 'missing-id'
  | 'duplicate-id'
  | 'missing-page-type'
  | 'page-type-mismatch'
  | 'missing-title'
  | 'missing-source-ids'
  | 'missing-import-provenance'
  | 'broken-wikilink'
  | 'contradiction-present'
  | 'claim-conflict'
  | 'open-question'
  | 'low-confidence'
  | 'claim-low-confidence'
  | 'claim-missing-evidence'
  | 'stale-page'
  | 'stale-claim'
  // Phase 1 — Audit Floor
  | 'claim-missing-attribution'
  | 'unlinked-entity-mention'
  | 'timeline-missing-attribution'
  // Phase 3 — MECE taxonomy
  | 'unknown-page-type'
  // Phase 6 — Anti-cramming + thinning length targets
  | 'page-length-cramming'
  | 'page-length-thinning';

export interface LintIssue {
  code: LintCheckCode;
  severity: LintSeverity;
  pagePath: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface LintResult {
  pageCount: number;
  issueCount: number;
  byCode: Record<LintCheckCode, number>;
  bySeverity: Record<LintSeverity, number>;
  issues: LintIssue[];
  durationMs: number;
}

type PageRecord = VaultPageRecord;

function collectPages(vaultPath: string): PageRecord[] {
  return collectVaultPages(vaultPath);
}

// =============================================================================
// Checks
// =============================================================================

function checkPage(
  page: PageRecord,
  pagesById: Map<string, PageRecord>,
  pagesByBasename: Map<string, PageRecord>,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const fm = page.frontmatter;

  // missing-id
  if (!fm.id) {
    issues.push({
      code: 'missing-id',
      severity: 'error',
      pagePath: page.relativePath,
      message: 'page is missing required `id` frontmatter field',
    });
  }

  // missing-page-type / unknown-page-type / page-type-mismatch
  if (!fm.pageType) {
    issues.push({
      code: 'missing-page-type',
      severity: 'error',
      pagePath: page.relativePath,
      message: 'page is missing required `pageType` frontmatter field',
    });
  } else if (!KNOWN_PAGE_KINDS.has(fm.pageType)) {
    // Phase 3: a pageType that doesn't map to any directory in the
    // taxonomy is a harder error than page-type-mismatch — the value
    // is outright invalid. Surface it distinctly so Janus knows to fix
    // the frontmatter, not move the file.
    issues.push({
      code: 'unknown-page-type',
      severity: 'error',
      pagePath: page.relativePath,
      message: `pageType=\`${fm.pageType}\` is not one of the recognised kinds`,
    });
  } else if (fm.pageType !== page.expectedKind) {
    issues.push({
      code: 'page-type-mismatch',
      severity: 'error',
      pagePath: page.relativePath,
      message: `pageType=\`${fm.pageType}\` does not match directory=\`${page.expectedKind}\``,
    });
  }

  // missing-title
  if (!fm.title || fm.title.trim() === '') {
    const h1Match = page.body.match(/^#\s+(.+)$/m);
    if (!h1Match) {
      issues.push({
        code: 'missing-title',
        severity: 'error',
        pagePath: page.relativePath,
        message: 'page has no `title` frontmatter field and no `# H1` heading',
      });
    }
  }

  // missing-source-ids (warning, only for non-source/report/hub pages).
  // Hubs are navigation pages whose bodies are entirely managed blocks;
  // asking them for provenance makes no sense.
  if (
    page.expectedKind !== 'source' &&
    page.expectedKind !== 'report' &&
    page.expectedKind !== 'hub' &&
    (!Array.isArray(fm.sourceIds) || fm.sourceIds.length === 0)
  ) {
    issues.push({
      code: 'missing-source-ids',
      severity: 'warning',
      pagePath: page.relativePath,
      message: 'page has empty `sourceIds` — no provenance citations',
    });
  }

  // missing-import-provenance (only for source pages with bridge type)
  if (
    page.expectedKind === 'source' &&
    typeof fm.sourceType === 'string' &&
    fm.sourceType.startsWith('memory-bridge') &&
    (!fm.sourcePath || !fm.bridgeRelativePath || !fm.bridgeWorkspaceDir)
  ) {
    issues.push({
      code: 'missing-import-provenance',
      severity: 'warning',
      pagePath: page.relativePath,
      message: 'bridge source page is missing required provenance fields',
    });
  }

  // broken-wikilink
  const links = extractWikiLinks(page.body);
  for (const target of links) {
    if (
      !pagesByBasename.has(target) &&
      !pagesById.has(`entity.${target}`) &&
      !pagesById.has(`concept.${target}`) &&
      !pagesById.has(`synthesis.${target}`)
    ) {
      issues.push({
        code: 'broken-wikilink',
        severity: 'warning',
        pagePath: page.relativePath,
        message: `wikilink \`[[${target}]]\` does not resolve to any page`,
      });
    }
  }

  // contradiction-present
  if (Array.isArray(fm.contradictions) && fm.contradictions.length > 0) {
    issues.push({
      code: 'contradiction-present',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `${fm.contradictions.length} contradiction note(s) present`,
    });
  }

  // open-question
  if (Array.isArray(fm.questions) && fm.questions.length > 0) {
    issues.push({
      code: 'open-question',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `${fm.questions.length} open question(s)`,
    });
  }

  // low-confidence
  if (typeof fm.confidence === 'number' && fm.confidence < 0.5) {
    issues.push({
      code: 'low-confidence',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `page confidence ${fm.confidence} < 0.5`,
    });
  }

  // stale-page
  const pageFreshness = assessPageFreshness(fm.updatedAt);
  if (pageFreshness === 'stale' || pageFreshness === 'unknown') {
    issues.push({
      code: 'stale-page',
      severity: 'warning',
      pagePath: page.relativePath,
      message:
        pageFreshness === 'stale'
          ? `page not touched in >${WIKI_STALE_DAYS} days`
          : 'page has no `updatedAt` field',
    });
  }

  // Claim-level checks
  const claims = Array.isArray(fm.claims) ? fm.claims : [];
  for (const claim of claims) {
    if (isLowConfidence(claim.confidence)) {
      issues.push({
        code: 'claim-low-confidence',
        severity: 'warning',
        pagePath: page.relativePath,
        message: `claim "${claim.text.slice(0, 60)}..." has confidence < 0.5`,
        context: { claimId: claim.id },
      });
    }
    if (isMissingEvidence(claim)) {
      issues.push({
        code: 'claim-missing-evidence',
        severity: 'warning',
        pagePath: page.relativePath,
        message: `claim "${claim.text.slice(0, 60)}..." has no evidence`,
        context: { claimId: claim.id },
      });
    }
    const claimFreshness = assessClaimFreshness(claim, fm.updatedAt);
    if (claimFreshness === 'stale') {
      issues.push({
        code: 'stale-claim',
        severity: 'warning',
        pagePath: page.relativePath,
        message: `claim "${claim.text.slice(0, 60)}..." not refreshed in >${WIKI_STALE_DAYS} days`,
        context: { claimId: claim.id },
      });
    }
  }

  return issues;
}

function checkDuplicateIds(pages: PageRecord[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const byId = new Map<string, PageRecord[]>();
  for (const p of pages) {
    if (!p.frontmatter.id) continue;
    const arr = byId.get(p.frontmatter.id) || [];
    arr.push(p);
    byId.set(p.frontmatter.id, arr);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const p of list) {
      issues.push({
        code: 'duplicate-id',
        severity: 'error',
        pagePath: p.relativePath,
        message: `duplicate id \`${id}\` shared with: ${list
          .filter((x) => x !== p)
          .map((x) => x.relativePath)
          .join(', ')}`,
      });
    }
  }
  return issues;
}

function checkClaimConflicts(pages: PageRecord[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const byClaimId = new Map<string, { page: PageRecord; claim: WikiClaim }[]>();
  for (const p of pages) {
    const claims = Array.isArray(p.frontmatter.claims)
      ? p.frontmatter.claims
      : [];
    for (const claim of claims) {
      if (!claim.id) continue;
      const arr = byClaimId.get(claim.id) || [];
      arr.push({ page: p, claim });
      byClaimId.set(claim.id, arr);
    }
  }
  for (const [id, entries] of byClaimId) {
    if (entries.length < 2) continue;
    const distinctKeys = new Set(
      entries.map((e) => `${e.claim.text}|${e.claim.status || ''}`),
    );
    if (distinctKeys.size < 2) continue;
    for (const e of entries) {
      issues.push({
        code: 'claim-conflict',
        severity: 'warning',
        pagePath: e.page.relativePath,
        message: `claim id \`${id}\` differs across ${entries.length} pages`,
      });
    }
  }
  return issues;
}

// =============================================================================
// Phase 1: Source attribution checks
// =============================================================================

const ATTRIBUTION_REQUIRED_KINDS: ReadonlySet<WikiPageKind> =
  new Set<WikiPageKind>([
    'entity',
    // Phase 3 will add person/company/business/deal/project here
  ]);

function checkClaimAttribution(page: PageRecord): LintIssue[] {
  const issues: LintIssue[] = [];
  if (page.kind === 'source' || page.kind === 'report') return issues;

  const claims = Array.isArray(page.frontmatter.claims)
    ? page.frontmatter.claims
    : [];
  if (claims.length === 0) return issues;

  const severity: LintSeverity = ATTRIBUTION_REQUIRED_KINDS.has(
    page.expectedKind,
  )
    ? 'error'
    : 'warning';

  for (const claim of claims) {
    if (claimHasSourceAttribution(claim)) continue;
    issues.push({
      code: 'claim-missing-attribution',
      severity,
      pagePath: page.relativePath,
      message: `claim "${claim.text.slice(0, 60)}..." has no parseable [Source: ...] attribution`,
      context: { claimId: claim.id },
    });
  }
  return issues;
}

// Module-scope regex — hoisted out of checkTimelineAttribution so we
// don't allocate a new RegExp on every page scan.
const TIMELINE_BLOCK_RE =
  /<!--\s*openclaw:wiki:timeline:start\s*-->([\s\S]*?)<!--\s*openclaw:wiki:timeline:end\s*-->/;

/**
 * Phase 5 stub: runs against the auto-generated `## Timeline` managed
 * block body once Phase 5 ships. Until then the block is absent on
 * every page and this is a no-op.
 */
function checkTimelineAttribution(page: PageRecord): LintIssue[] {
  const issues: LintIssue[] = [];
  const m = page.body.match(TIMELINE_BLOCK_RE);
  if (!m) return issues;

  const blockBody = m[1];
  // Timeline entries are bullet lines: `- <date> [Source: ...] — text`
  const lines = blockBody.split('\n').filter((l) => l.trim().startsWith('- '));
  for (const line of lines) {
    if (!SOURCE_ATTRIBUTION_RE.test(line)) {
      issues.push({
        code: 'timeline-missing-attribution',
        severity: 'warning',
        pagePath: page.relativePath,
        message: `timeline entry has no [Source: ...] attribution: "${line.slice(0, 80)}..."`,
      });
    }
  }
  return issues;
}

// =============================================================================
// Phase 6: Anti-cramming + thinning — page-length-target
// =============================================================================
//
// Flags pages that have drifted way outside the target length for their
// kind. Cramming (>1.25× ceiling) signals a page accumulating multiple
// themes that should probably be split into focused children. Thinning
// (<0.5× floor) signals a stub that should either be enriched or merged.
//
// Targets are intentionally generous — the rule fires on real outliers,
// not honest length variation. Length counts prose lines only: strip
// frontmatter and managed blocks first, then count lines with
// non-whitespace content.
//
// Kinds without length expectations (hub, original, source, report,
// inbox-item) are exempt. Hub bodies are almost entirely managed blocks,
// originals are verbatim capture, sources are extractor output, reports
// are generated, inbox-items are triage stubs.

const LENGTH_TARGETS: Partial<
  Record<WikiPageKind, { floor: number; ceiling: number }>
> = {
  person: { floor: 20, ceiling: 80 },
  company: { floor: 20, ceiling: 60 },
  project: { floor: 30, ceiling: 80 },
  concept: { floor: 20, ceiling: 80 },
  deal: { floor: 20, ceiling: 50 },
  synthesis: { floor: 60, ceiling: 120 },
};

// Match any Openclaw-managed block so it can be stripped before counting
// prose lines. Mirrors the pattern used in hub-projection.ts.
const MANAGED_BLOCK_RE =
  /<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g;

function countProseLines(body: string): number {
  // Strip any managed blocks first; they're generated, not authored.
  const stripped = body.replace(MANAGED_BLOCK_RE, '');
  return stripped.split('\n').filter((l) => l.trim().length > 0).length;
}

function checkPageLength(page: PageRecord): LintIssue[] {
  const target = LENGTH_TARGETS[page.expectedKind];
  if (!target) return [];
  const lines = countProseLines(page.body);
  const issues: LintIssue[] = [];
  if (lines > target.ceiling * 1.25) {
    issues.push({
      code: 'page-length-cramming',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `page has ${lines} prose lines (target ${target.floor}–${target.ceiling}). Consider splitting into focused children.`,
      context: { lines, floor: target.floor, ceiling: target.ceiling },
    });
  } else if (lines < target.floor * 0.5) {
    issues.push({
      code: 'page-length-thinning',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `page has ${lines} prose lines (target ${target.floor}–${target.ceiling}). Consider enriching or merging into a richer page.`,
      context: { lines, floor: target.floor, ceiling: target.ceiling },
    });
  }
  return issues;
}

// =============================================================================
// Phase 1: Iron law of back-linking — unlinked-entity-mention
// =============================================================================

// Regex stripping patterns — hoisted so each call reuses one set of
// compiled RegExps instead of allocating fresh ones per page.
const STRIP_PATTERNS: RegExp[] = [
  /^---\n[\s\S]*?\n---\n/, // stray frontmatter
  /```[\s\S]*?```/g, // fenced code
  /~~~[\s\S]*?~~~/g, // alt-fence code
  /<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g,
  /<!--\s*openclaw:human:start\s*-->[\s\S]*?<!--\s*openclaw:human:end\s*-->/g,
  /<!--[\s\S]*?-->/g, // any HTML comment
  /`[^`\n]+`/g, // inline code
  /\[\[[^\]]+\]\]/g, // [[wikilinks]]
  /\[[^\]]*\]\([^)]+\)/g, // [md](links)
  /^#{1,6}\s.*$/gm, // headings
];

/**
 * Strip regions of the body where entity mentions should NOT be
 * detected: code fences, managed blocks, HTML comments, existing
 * wikilinks/md-links, headings.
 */
function extractScannableProse(body: string): string {
  let text = body;
  for (const re of STRIP_PATTERNS) text = text.replace(re, ' ');
  return text;
}

interface MentionCandidate {
  term: string;
  targetPageId: string;
  targetBasename: string;
  targetTitle: string;
  index: number;
}

/**
 * Precomputed target index for unlinked-mention detection. Built ONCE
 * per lint run (not per page) so the O(pages²) regex compilation loop
 * becomes O(pages) compiled-once + one alternation match per page.
 *
 * `regex` is a single global alternation `\b(Title1|Title2|...)\b`
 * with a capture group. `targetByTerm` maps the matched string back
 * to its page record.
 */
interface MentionTargetIndex {
  regex: RegExp | null;
  targetByTerm: Map<string, PageRecord>;
}

function buildMentionTargetIndex(
  pages: PageRecord[],
  blocklist: Set<string>,
): MentionTargetIndex {
  const targetByTerm = new Map<string, PageRecord>();
  const terms: string[] = [];
  for (const target of pages) {
    // Originals are verbatim quotes, not entities — their titles are full
    // sentences that legitimately repeat across prose. Skip as targets.
    if (target.kind === 'original') continue;
    // Hubs are navigation pages with generic titles (People, Businesses,
    // Playbooks, ...). Their words collide with common prose nouns and
    // should never be auto-wikilinked.
    if (target.kind === 'hub') continue;
    const title = target.frontmatter.title || '';
    if (title.length < 4 || !/^[A-Z]/.test(title)) continue;
    if (blocklist.has(title.toLowerCase())) continue;
    if (targetByTerm.has(title)) continue; // duplicate titles: first wins
    targetByTerm.set(title, target);
    terms.push(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  if (terms.length === 0) return { regex: null, targetByTerm };
  // Longer terms first so "Dom Ingleston" wins over "Dom" at the same
  // position in the alternation.
  terms.sort((a, b) => b.length - a.length);
  return {
    regex: new RegExp(`\\b(${terms.join('|')})\\b`, 'g'),
    targetByTerm,
  };
}

function findUnlinkedMentions(
  page: PageRecord,
  index: MentionTargetIndex,
): MentionCandidate[] {
  if (!index.regex) return [];
  const prose = extractScannableProse(page.body);
  const seen = new Set<string>();
  const unique: MentionCandidate[] = [];
  // Reset lastIndex so repeated calls against the same global regex
  // walk from the top each time.
  index.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = index.regex.exec(prose)) !== null) {
    const term = m[1];
    const target = index.targetByTerm.get(term);
    if (!target) continue;
    if (target.filePath === page.filePath) continue; // self-mention
    const targetPageId = target.frontmatter.id || target.basename;
    if (seen.has(targetPageId)) continue;
    seen.add(targetPageId);
    unique.push({
      term,
      targetPageId,
      targetBasename: target.basename,
      targetTitle: target.frontmatter.title || target.basename,
      index: m.index,
    });
  }
  return unique;
}

function checkUnlinkedMentions(
  page: PageRecord,
  index: MentionTargetIndex,
): LintIssue[] {
  const issues: LintIssue[] = [];
  if (
    page.kind === 'source' ||
    page.kind === 'report' ||
    page.kind === 'original'
  )
    return issues;

  // "One wikilink per target per page is enough." If the page already
  // links to the target at least once, subsequent plain-text mentions
  // are fine — Obsidian's backlinks panel and graph view surface them.
  const existingLinks = new Set(extractWikiLinks(page.body));

  const candidates = findUnlinkedMentions(page, index);
  for (const c of candidates) {
    if (existingLinks.has(c.targetBasename)) continue;
    issues.push({
      code: 'unlinked-entity-mention',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `mentions "${c.term}" in prose but does not link to [[${c.targetBasename}]]`,
      context: {
        term: c.term,
        targetPageId: c.targetPageId,
        targetBasename: c.targetBasename,
      },
    });
  }
  return issues;
}

// =============================================================================
// Report writer
// =============================================================================

function buildLintReport(result: LintResult): string {
  const lines: string[] = [];
  lines.push(`Wiki lint pass run at ${new Date().toISOString()}.`);
  lines.push('');
  lines.push(
    `**Pages:** ${result.pageCount}  **Issues:** ${result.issueCount}  ` +
      `**Errors:** ${result.bySeverity.error}  **Warnings:** ${result.bySeverity.warning}`,
  );
  lines.push('');

  if (result.issueCount === 0) {
    lines.push('No issues found.');
    return lines.join('\n');
  }

  // Issues by code
  lines.push('## Issues by Check');
  lines.push('');
  for (const [code, count] of Object.entries(result.byCode).sort(
    (a, b) => b[1] - a[1],
  )) {
    if (count === 0) continue;
    lines.push(`- **${code}** — ${count}`);
  }
  lines.push('');

  // Issues by page
  const byPage = new Map<string, LintIssue[]>();
  for (const issue of result.issues) {
    const arr = byPage.get(issue.pagePath) || [];
    arr.push(issue);
    byPage.set(issue.pagePath, arr);
  }
  lines.push('## Issues by Page');
  lines.push('');
  for (const [pagePath, issues] of [...byPage].sort()) {
    lines.push(`### \`${pagePath}\``);
    for (const issue of issues) {
      const sev = issue.severity === 'error' ? '🔴' : '🟡';
      lines.push(`- ${sev} **${issue.code}** — ${issue.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeLintReport(vaultPath: string, result: LintResult): void {
  const reportPath = path.join(vaultPath, 'reports', 'lint.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const body = buildLintReport(result);
  const nowIso = new Date().toISOString();

  // Always rewrite frontmatter with fresh updatedAt so the lint page itself
  // doesn't trip the stale-page check.
  const seedFrontmatter = `---
id: report.lint
pageType: report
title: Lint Health Report
sourceIds: []
claims: []
contradictions: []
questions: []
confidence: 0.7
status: active
updatedAt: "${nowIso}"
---

# Lint Health Report

`;

  const existing = fs.existsSync(reportPath)
    ? fs.readFileSync(reportPath, 'utf-8')
    : seedFrontmatter;

  // If the existing file already has frontmatter, only refresh the updatedAt
  // line; otherwise replace with the seed.
  let withFreshFrontmatter: string;
  if (existing.startsWith('---')) {
    withFreshFrontmatter = existing.replace(
      /updatedAt:\s*[^\n]+/,
      `updatedAt: "${nowIso}"`,
    );
  } else {
    withFreshFrontmatter = seedFrontmatter + existing;
  }

  const newContent = replaceManagedBlock(withFreshFrontmatter, 'lint', body);
  fs.writeFileSync(reportPath, newContent);
}

// =============================================================================
// Public entry point
// =============================================================================

export async function lintWiki(vaultPath: string): Promise<LintResult> {
  const startedAt = Date.now();
  const pages = collectPages(vaultPath);
  const collisionBlocklist = loadCollisionBlocklist(vaultPath);

  const pagesById = new Map<string, PageRecord>();
  const pagesByBasename = new Map<string, PageRecord>();
  for (const p of pages) {
    if (p.frontmatter.id) pagesById.set(p.frontmatter.id, p);
    pagesByBasename.set(p.basename, p);
  }

  // Build the mention-target alternation regex ONCE — reused across
  // every page in the loop below. Previously this was recomputed per
  // page, turning the check into O(pages²) regex compilations.
  const mentionIndex = buildMentionTargetIndex(pages, collisionBlocklist);

  const allIssues: LintIssue[] = [];
  for (const p of pages) {
    allIssues.push(...checkPage(p, pagesById, pagesByBasename));
    allIssues.push(...checkClaimAttribution(p));
    allIssues.push(...checkTimelineAttribution(p));
    allIssues.push(...checkUnlinkedMentions(p, mentionIndex));
    allIssues.push(...checkPageLength(p));
  }
  allIssues.push(...checkDuplicateIds(pages));
  allIssues.push(...checkClaimConflicts(pages));

  const byCode = {} as Record<LintCheckCode, number>;
  const bySeverity: Record<LintSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const issue of allIssues) {
    byCode[issue.code] = (byCode[issue.code] || 0) + 1;
    bySeverity[issue.severity]++;
  }

  const result: LintResult = {
    pageCount: pages.length,
    issueCount: allIssues.length,
    byCode,
    bySeverity,
    issues: allIssues,
    durationMs: Date.now() - startedAt,
  };

  writeLintReport(vaultPath, result);
  appendWikiLogEvent(vaultPath, 'lint', {
    pageCount: result.pageCount,
    issueCount: result.issueCount,
    bySeverity: result.bySeverity,
    durationMs: result.durationMs,
  });

  return result;
}
