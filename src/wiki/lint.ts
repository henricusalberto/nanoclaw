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
import { readJsonOrDefault } from './fs-util.js';
import { appendWikiLogEvent } from './log.js';
import {
  extractWikiLinks,
  parseWikiPage,
  readWikiPage,
  replaceManagedBlock,
  WikiClaim,
  WikiPageFrontmatter,
  WikiPageKind,
} from './markdown.js';
import { vaultPaths } from './paths.js';
import {
  claimHasSourceAttribution,
  extractAllSourceAttributions,
  SOURCE_ATTRIBUTION_RE,
} from './source-attribution.js';

const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = [
  { dir: 'entities', kind: 'entity' },
  { dir: 'concepts', kind: 'concept' },
  { dir: 'syntheses', kind: 'synthesis' },
  { dir: 'sources', kind: 'source' },
  { dir: 'originals', kind: 'original' },
  // Phase 3 — MECE taxonomy expansion.
  { dir: 'people', kind: 'person' },
  { dir: 'companies', kind: 'company' },
  { dir: 'meetings', kind: 'meeting' },
  { dir: 'deals', kind: 'deal' },
  { dir: 'projects', kind: 'project' },
  { dir: 'ideas', kind: 'idea' },
  { dir: 'writing', kind: 'writing' },
  { dir: 'personal', kind: 'personal-note' },
  { dir: 'household', kind: 'household-item' },
  { dir: 'inbox', kind: 'inbox-item' },
  // reports/ deliberately excluded — those are lint's own output, linting
  // them would be circular noise
];

// Phase 3: every recognised page kind. Built from VAULT_DIRS plus
// `report` (which lives in reports/ but is excluded from the lint
// walk itself). Used by `unknown-page-type` to reject typos or kinds
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
  | 'unknown-page-type';

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

interface PageRecord {
  filePath: string;
  relativePath: string;
  basename: string;
  kind: WikiPageKind | undefined;
  expectedKind: WikiPageKind;
  frontmatter: WikiPageFrontmatter;
  body: string;
}

// =============================================================================
// Collision blocklist — words that happen to collide with page titles or
// basenames but shouldn't trigger unlinked-entity-mention warnings.
// Seeded on first run if missing.
// =============================================================================

const DEFAULT_COLLISION_BLOCKLIST: string[] = [
  // Common English words that are also valid title-case tokens
  'The',
  'A',
  'An',
  'And',
  'Or',
  'But',
  'If',
  'Then',
  'When',
  'Where',
  'What',
  'Why',
  'How',
  'Who',
  'With',
  'Without',
  'From',
  'To',
  'In',
  'On',
  'At',
  'By',
  'For',
  'Of',
  'As',
  'Is',
  'Was',
  'Are',
  'Were',
  'Be',
  'Been',
  'Being',
  'Have',
  'Has',
  'Had',
  'Do',
  'Does',
  'Did',
  'Will',
  'Would',
  'Could',
  'Should',
  'May',
  'Might',
  'Can',
  'Cannot',
  'Not',
  'No',
  'Yes',
  'All',
  'Any',
  'Each',
  'Every',
  'Some',
  'Most',
  'More',
  'Less',
  'Very',
  'Just',
  'Only',
  'Also',
  'Even',
  'Still',
  'Yet',
  'Now',
  'Then',
  'Here',
  'There',
  'Today',
  'Yesterday',
  'Tomorrow',
  // NanoClaw-specific false positives
  'Wiki',
  'Source',
  'Note',
  'Goal',
  'Status',
  'Overview',
  'Content',
];

function loadCollisionBlocklist(vaultPath: string): Set<string> {
  const blocklistPath = path.join(
    vaultPaths(vaultPath).stateDir,
    'entity-collision-blocklist.json',
  );
  const data = readJsonOrDefault<{ blocklist: string[] }>(blocklistPath, {
    blocklist: DEFAULT_COLLISION_BLOCKLIST,
  });
  const words = Array.isArray(data.blocklist)
    ? data.blocklist
    : DEFAULT_COLLISION_BLOCKLIST;
  return new Set(words.map((w) => w.toLowerCase()));
}

// =============================================================================
// Walk + parse
// =============================================================================

function collectPages(vaultPath: string): PageRecord[] {
  const records: PageRecord[] = [];
  for (const { dir, kind: expectedKind } of VAULT_DIRS) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md') continue;
      const filePath = path.join(dirPath, entry.name);
      const parsed = readWikiPage(filePath);
      records.push({
        filePath,
        relativePath: path.relative(vaultPath, filePath),
        basename: path.basename(entry.name, '.md').toLowerCase(),
        kind: parsed.frontmatter.pageType,
        expectedKind,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    }
  }
  return records;
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

  // missing-source-ids (warning, only for non-source/report pages)
  if (
    page.expectedKind !== 'source' &&
    page.expectedKind !== 'report' &&
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

/**
 * Phase 5 stub: timeline-missing-attribution. Runs against the auto-
 * generated `## Timeline` managed block body when Phase 5 ships. Until
 * then, this check is a no-op (blocks don't exist yet).
 */
function checkTimelineAttribution(page: PageRecord): LintIssue[] {
  const issues: LintIssue[] = [];
  const TIMELINE_BLOCK_RE =
    /<!--\s*openclaw:wiki:timeline:start\s*-->([\s\S]*?)<!--\s*openclaw:wiki:timeline:end\s*-->/;
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
// Phase 1: Iron law of back-linking — unlinked-entity-mention
// =============================================================================

/**
 * Strip regions of the body where entity mentions should NOT be detected:
 *   - Frontmatter block (between the first two `---` lines)
 *   - Fenced code blocks (```...```)
 *   - Inline code (`...`)
 *   - Existing [[wikilinks]] and [md](links)
 *   - Any managed block `<!-- openclaw:wiki:*:start --> ... :end -->`
 *   - HTML comments
 *   - Line-start headings (to avoid matching page H1 as an "unlinked mention")
 */
function extractScannableProse(body: string): string {
  let text = body;
  // Frontmatter (if somehow present in body — shouldn't be after parseWikiPage)
  text = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/~~~[\s\S]*?~~~/g, ' ');
  // Any managed block
  text = text.replace(
    /<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g,
    ' ',
  );
  text = text.replace(
    /<!--\s*openclaw:human:start\s*-->[\s\S]*?<!--\s*openclaw:human:end\s*-->/g,
    ' ',
  );
  // HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // Inline code
  text = text.replace(/`[^`\n]+`/g, ' ');
  // Wikilinks [[...]]
  text = text.replace(/\[\[[^\]]+\]\]/g, ' ');
  // Markdown links [text](url)
  text = text.replace(/\[[^\]]*\]\([^)]+\)/g, ' ');
  // Headings (entire lines starting with #)
  text = text.replace(/^#{1,6}\s.*$/gm, ' ');
  return text;
}

interface MentionCandidate {
  /** The literal string found in body */
  term: string;
  /** The page id to link to */
  targetPageId: string;
  /** The page basename (for wikilink rendering) */
  targetBasename: string;
  /** The page title (for display) */
  targetTitle: string;
  /** Index into the cleaned body where the match starts */
  index: number;
}

function findUnlinkedMentions(
  page: PageRecord,
  allPages: PageRecord[],
  blocklist: Set<string>,
): MentionCandidate[] {
  const prose = extractScannableProse(page.body);
  const candidates: MentionCandidate[] = [];

  // Build a list of (term, page) pairs to search for. Use each page's
  // title (length ≥4, excluding blocklist) AND each page's basename if
  // it's multi-word or CamelCase.
  const targets: { term: string; target: PageRecord }[] = [];
  for (const target of allPages) {
    if (target.filePath === page.filePath) continue;
    const title = target.frontmatter.title || '';
    if (title.length >= 4 && /^[A-Z]/.test(title)) {
      // Only search for distinctive titles — skip blocklist members
      if (!blocklist.has(title.toLowerCase())) {
        targets.push({ term: title, target });
      }
    }
    // Also search for the basename as a capitalized slug (e.g. "dom-ingleston"
    // would match "Dom Ingleston" — already covered by title). Skip basename
    // matching for now to avoid double-counting.
  }

  for (const { term, target } of targets) {
    // Escape regex special chars in term
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word-boundary match, case-sensitive (to preserve capitalization
    // signal), global to find all occurrences
    const re = new RegExp(`\\b${escaped}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(prose)) !== null) {
      candidates.push({
        term: m[0],
        targetPageId: target.frontmatter.id || target.basename,
        targetBasename: target.basename,
        targetTitle: target.frontmatter.title || target.basename,
        index: m.index,
      });
    }
  }

  // Deduplicate: one warning per (page, targetPageId) pair, not per occurrence.
  const seen = new Set<string>();
  const unique: MentionCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.targetPageId)) continue;
    seen.add(c.targetPageId);
    unique.push(c);
  }

  return unique;
}

function checkUnlinkedMentions(
  page: PageRecord,
  allPages: PageRecord[],
  blocklist: Set<string>,
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

  const candidates = findUnlinkedMentions(page, allPages, blocklist);
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

  const allIssues: LintIssue[] = [];
  for (const p of pages) {
    allIssues.push(...checkPage(p, pagesById, pagesByBasename));
    // Phase 1 checks
    allIssues.push(...checkClaimAttribution(p));
    allIssues.push(...checkTimelineAttribution(p));
    allIssues.push(...checkUnlinkedMentions(p, pages, collisionBlocklist));
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
