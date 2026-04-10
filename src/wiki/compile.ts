/**
 * Wiki compile pipeline.
 *
 * Walks the vault, parses every page, computes related blocks, and rewrites
 * each page's `## Related` managed block. Also regenerates index.md and
 * per-directory indexes (entities/index.md, concepts/index.md, etc).
 *
 * Caches (agent-digest.json, claims.jsonl) are emitted in Phase 4.
 *
 * Compile is idempotent: running it twice on an unchanged vault produces
 * byte-identical output.
 */

import fs from 'fs';
import path from 'path';

import {
  buildAgentDigest,
  buildClaimsJsonlLines,
  writeAgentDigest,
  writeClaimsJsonl,
} from './digest.js';
import { lintWiki } from './lint.js';
import { appendWikiLogEvent } from './log.js';
import {
  parseWikiPage,
  readWikiPage,
  replaceManagedBlock,
  serializeWikiPage,
  WikiPageKind,
} from './markdown.js';
import {
  computeRelatedBuckets,
  PageSummary,
  renderRelatedBlock,
  summarizePage,
} from './related.js';

const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = [
  // Legacy 5-dir layout — still produced by older vaults and OpenClaw.
  // Migration flows upgrade entities → people/companies but we keep the
  // entities/ entry so mid-migration vaults still compile.
  { dir: 'entities', kind: 'entity' },
  { dir: 'concepts', kind: 'concept' },
  { dir: 'syntheses', kind: 'synthesis' },
  { dir: 'sources', kind: 'source' },
  { dir: 'reports', kind: 'report' },
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
];

const MANAGED_BLOCK_NAME = 'related';

export interface CompileResult {
  pageCount: number;
  rewrittenCount: number;
  indexesRefreshed: number;
  digestPageCount: number;
  digestClaimCount: number;
  /** Phase 1: lint counts surfaced for Janus via agent-digest */
  lintIssueCount: number;
  lintErrorCount: number;
  lintWarningCount: number;
  missingAttributions: number;
  unlinkedMentions: number;
  durationMs: number;
}

// =============================================================================
// Page collection
// =============================================================================

function walkVault(
  vaultPath: string,
): { absPath: string; kind: WikiPageKind }[] {
  const results: { absPath: string; kind: WikiPageKind }[] = [];
  for (const { dir, kind } of VAULT_DIRS) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      results.push({ absPath: path.join(dirPath, entry.name), kind });
    }
  }
  return results;
}

function collectPageSummaries(vaultPath: string): {
  summaries: PageSummary[];
  parsedByPath: Map<string, ReturnType<typeof parseWikiPage>>;
} {
  const summaries: PageSummary[] = [];
  const parsedByPath = new Map<string, ReturnType<typeof parseWikiPage>>();
  for (const { absPath } of walkVault(vaultPath)) {
    let parsed;
    try {
      parsed = readWikiPage(absPath);
    } catch {
      continue;
    }
    const summary = summarizePage(absPath, vaultPath, parsed);
    if (!summary) continue;
    summaries.push(summary);
    parsedByPath.set(absPath, parsed);
  }
  return { summaries, parsedByPath };
}

// =============================================================================
// Related block rewriting
// =============================================================================

function refreshRelatedBlocks(
  vaultPath: string,
  summaries: PageSummary[],
  parsedByPath: Map<string, ReturnType<typeof parseWikiPage>>,
): number {
  const pagesById = new Map<string, PageSummary>();
  const pagesByBasename = new Map<string, PageSummary>();
  for (const s of summaries) {
    pagesById.set(s.id, s);
    pagesByBasename.set(s.basename, s);
  }

  let rewritten = 0;
  for (const page of summaries) {
    // Skip source pages — bridge owns them, related blocks would just churn
    // (they get fully overwritten on every bridge sync anyway)
    if (page.kind === 'source') continue;
    // Skip report pages — they're auto-generated dashboards
    if (page.kind === 'report') continue;

    const buckets = computeRelatedBuckets(
      page,
      summaries,
      pagesById,
      pagesByBasename,
    );
    const blockBody = renderRelatedBlock(buckets);

    const parsed = parsedByPath.get(page.filePath);
    if (!parsed) continue;

    const newBody = replaceManagedBlock(
      parsed.body,
      MANAGED_BLOCK_NAME,
      blockBody,
    );
    if (newBody === parsed.body) continue;

    const newContent = serializeWikiPage(parsed.frontmatter, newBody);
    const tempPath = `${page.filePath}.tmp`;
    fs.writeFileSync(tempPath, newContent);
    fs.renameSync(tempPath, page.filePath);
    rewritten++;
  }
  return rewritten;
}

// =============================================================================
// Index regeneration
// =============================================================================

const INDEX_BLOCK_NAME = 'index';

function buildIndexBody(
  pages: PageSummary[],
  groupBy: 'directory' | 'kind',
): string {
  const lines: string[] = [];
  if (groupBy === 'directory') {
    const byDir = new Map<string, PageSummary[]>();
    for (const p of pages) {
      const dir = p.relativePath.split(path.sep)[0];
      const arr = byDir.get(dir) || [];
      arr.push(p);
      byDir.set(dir, arr);
    }
    for (const [dir, arr] of [...byDir].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      lines.push(`### ${dir}/`);
      arr.sort((a, b) => a.title.localeCompare(b.title));
      for (const p of arr) {
        lines.push(`- [[${p.basename}|${p.title}]]`);
      }
      lines.push('');
    }
  } else {
    const sorted = [...pages].sort((a, b) => a.title.localeCompare(b.title));
    for (const p of sorted) {
      lines.push(`- [[${p.basename}|${p.title}]]`);
    }
  }
  return lines.join('\n').trimEnd();
}

function refreshIndexes(vaultPath: string, summaries: PageSummary[]): number {
  let count = 0;

  // Per-directory indexes
  for (const { dir } of VAULT_DIRS) {
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    const dirPages = summaries.filter(
      (p) => p.relativePath.split(path.sep)[0] === dir,
    );
    if (dirPages.length === 0) continue;
    const indexPath = path.join(dirPath, 'index.md');
    const body = buildIndexBody(dirPages, 'kind');
    const existingContent = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, 'utf-8')
      : `# ${dir.charAt(0).toUpperCase() + dir.slice(1)}\n\n`;
    const newContent = replaceManagedBlock(
      existingContent,
      INDEX_BLOCK_NAME,
      body,
    );
    if (newContent !== existingContent) {
      fs.writeFileSync(indexPath, newContent);
      count++;
    }
  }

  // Root index
  const rootIndexPath = path.join(vaultPath, 'index.md');
  const rootBody = buildIndexBody(summaries, 'directory');
  const existingRoot = fs.existsSync(rootIndexPath)
    ? fs.readFileSync(rootIndexPath, 'utf-8')
    : `# Wiki Index\n\nThe catalog of every page in this wiki, organized by category. Updated on every compile pass.\n\n`;
  const newRoot = replaceManagedBlock(existingRoot, INDEX_BLOCK_NAME, rootBody);
  if (newRoot !== existingRoot) {
    fs.writeFileSync(rootIndexPath, newRoot);
    count++;
  }

  return count;
}

// =============================================================================
// Public entry point
// =============================================================================

export async function compileWiki(vaultPath: string): Promise<CompileResult> {
  const startedAt = Date.now();
  const { summaries, parsedByPath } = collectPageSummaries(vaultPath);

  const rewrittenCount = refreshRelatedBlocks(
    vaultPath,
    summaries,
    parsedByPath,
  );
  const indexesRefreshed = refreshIndexes(vaultPath, summaries);

  // The related-block rewrite only touches the body — frontmatter in
  // parsedByPath is still authoritative. Reuse it directly instead of
  // re-reading every page from disk.
  const digestInputs = summaries
    .map((summary) => {
      const parsed = parsedByPath.get(summary.filePath);
      if (!parsed) return null;
      return {
        filePath: summary.filePath,
        relativePath: summary.relativePath,
        frontmatter: parsed.frontmatter,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const digest = buildAgentDigest(digestInputs);

  // Phase 1: run lint inline and fold its summary into the digest so Janus
  // sees unlinked-mention and missing-attribution counts on every spawn
  // without needing to re-run lint manually. The full lint report still
  // lives at reports/lint.md.
  const lintResult = await lintWiki(vaultPath);
  const missingAttributions =
    (lintResult.byCode['claim-missing-attribution'] || 0) +
    (lintResult.byCode['timeline-missing-attribution'] || 0);
  const unlinkedMentions = lintResult.byCode['unlinked-entity-mention'] || 0;

  // Inject lint summary into the digest so the agent sees it alongside
  // page counts and claim health. Using a loose cast since the OpenClaw
  // AgentDigest type doesn't declare these additive fields — downstream
  // readers that don't know about them just ignore the extras.
  const digestWithLint = digest as unknown as Record<string, unknown>;
  digestWithLint.lintSummary = {
    issueCount: lintResult.issueCount,
    errorCount: lintResult.bySeverity.error,
    warningCount: lintResult.bySeverity.warning,
    byCode: lintResult.byCode,
  };

  writeAgentDigest(vaultPath, digest);
  writeClaimsJsonl(vaultPath, buildClaimsJsonlLines(digestInputs));

  const result: CompileResult = {
    pageCount: summaries.length,
    rewrittenCount,
    indexesRefreshed,
    digestPageCount: digest.pages.length,
    digestClaimCount: digest.claimCount,
    lintIssueCount: lintResult.issueCount,
    lintErrorCount: lintResult.bySeverity.error,
    lintWarningCount: lintResult.bySeverity.warning,
    missingAttributions,
    unlinkedMentions,
    durationMs: Date.now() - startedAt,
  };

  appendWikiLogEvent(vaultPath, 'compile', { ...result });
  return result;
}
