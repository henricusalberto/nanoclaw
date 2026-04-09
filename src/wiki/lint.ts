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
  readWikiPage,
  replaceManagedBlock,
  WikiClaim,
  WikiPageFrontmatter,
  WikiPageKind,
} from './markdown.js';

const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = [
  { dir: 'entities', kind: 'entity' },
  { dir: 'concepts', kind: 'concept' },
  { dir: 'syntheses', kind: 'synthesis' },
  { dir: 'sources', kind: 'source' },
  // reports/ deliberately excluded — those are lint's own output, linting
  // them would be circular noise
];

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
  | 'stale-claim';

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

  // missing-page-type
  if (!fm.pageType) {
    issues.push({
      code: 'missing-page-type',
      severity: 'error',
      pagePath: page.relativePath,
      message: 'page is missing required `pageType` frontmatter field',
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
    if (!pagesByBasename.has(target) && !pagesById.has(`entity.${target}`) &&
        !pagesById.has(`concept.${target}`) && !pagesById.has(`synthesis.${target}`)) {
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
        message: `duplicate id \`${id}\` shared with: ${list.filter((x) => x !== p).map((x) => x.relativePath).join(', ')}`,
      });
    }
  }
  return issues;
}

function checkClaimConflicts(pages: PageRecord[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const byClaimId = new Map<
    string,
    { page: PageRecord; claim: WikiClaim }[]
  >();
  for (const p of pages) {
    const claims = Array.isArray(p.frontmatter.claims) ? p.frontmatter.claims : [];
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

  const pagesById = new Map<string, PageRecord>();
  const pagesByBasename = new Map<string, PageRecord>();
  for (const p of pages) {
    if (p.frontmatter.id) pagesById.set(p.frontmatter.id, p);
    pagesByBasename.set(p.basename, p);
  }

  const allIssues: LintIssue[] = [];
  for (const p of pages) {
    allIssues.push(...checkPage(p, pagesById, pagesByBasename));
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
