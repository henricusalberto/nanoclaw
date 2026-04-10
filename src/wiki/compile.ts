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
  ParsedWikiPage,
  parseWikiPage,
  readWikiPage,
  replaceManagedBlock,
  serializeWikiPage,
  WikiPageKind,
  writeWikiPage,
} from './markdown.js';
import { buildGraph, writeGraphIndexIfChanged } from './graph.js';
import {
  computeRelatedBuckets,
  PageSummary,
  renderRelatedBlock,
  summarizePage,
} from './related.js';
import { projectTimelines } from './timeline-projection.js';
import {
  collectVaultPages,
  VAULT_DIRS as WALKED_DIRS,
  VaultPageRecord,
} from './vault-walk.js';
import {
  appendMetricsSnapshotIfChanged,
  classifyAll,
  ThresholdLevel,
  VolumeMetrics,
  writeVolumeReportIfChanged,
} from './volume-checker.js';

// Compile walks VAULT_DIRS plus reports/ (which lint excludes to avoid
// the circular "lint its own output" problem). Report pages still need
// index regeneration.
const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = [
  ...WALKED_DIRS,
  { dir: 'reports', kind: 'report' },
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
  /** Phase 4: compile-time managed-block projections. */
  timelinePagesRewritten: number;
  timelineEntriesTotal: number;
  graphNodes: number;
  graphEdges: number;
  volumeLevel: ThresholdLevel;
  durationMs: number;
}

// =============================================================================
// Page collection
// =============================================================================

/**
 * Single vault walk that produces BOTH the related-block-friendly
 * `PageSummary[]` AND the timeline/graph-friendly `VaultPageRecord[]`
 * from one set of disk reads. Previously compile walked the vault
 * twice (once via its own `walkVault` + `summarizePage`, once via the
 * shared `collectVaultPages`) — which doubled file reads on every spawn.
 *
 * `bytesByPath` is captured during the same walk so the volume
 * checker doesn't have to `statSync` every page a third time.
 *
 * Reports/ is walked too even though `collectVaultPages` skips it
 * (lint excludes its own output); compile still wants the reports
 * folded into digest + indexes.
 */
function collectAllPageData(vaultPath: string): {
  records: VaultPageRecord[];
  summaries: PageSummary[];
  parsedByPath: Map<string, ParsedWikiPage>;
  bytesByPath: Map<string, number>;
} {
  const records = [
    ...collectVaultPages(vaultPath),
    ...readReportRecords(vaultPath),
  ];
  const summaries: PageSummary[] = [];
  const parsedByPath = new Map<string, ParsedWikiPage>();
  const bytesByPath = new Map<string, number>();
  for (const r of records) {
    const parsed: ParsedWikiPage = {
      frontmatter: r.frontmatter,
      body: r.body,
      raw: '', // not needed downstream; serializer reconstructs
    };
    parsedByPath.set(r.filePath, parsed);
    bytesByPath.set(r.filePath, Buffer.byteLength(r.body, 'utf8'));
    const summary = summarizePage(r.filePath, vaultPath, parsed);
    if (summary) summaries.push(summary);
  }
  return { records, summaries, parsedByPath, bytesByPath };
}

function readReportRecords(vaultPath: string): VaultPageRecord[] {
  const dir = path.join(vaultPath, 'reports');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: VaultPageRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    if (entry.name === 'index.md') continue;
    const filePath = path.join(dir, entry.name);
    const parsed = readWikiPage(filePath);
    out.push({
      filePath,
      relativePath: path.relative(vaultPath, filePath),
      basename: path.basename(entry.name, '.md').toLowerCase(),
      dir: 'reports',
      kind: parsed.frontmatter.pageType,
      expectedKind: 'report',
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return out;
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

    writeWikiPage(page.filePath, parsed.frontmatter, newBody, {
      writtenBy: 'compile',
      reason: 'related-block refresh',
      // Auto-managed-block edit only — skip the per-write version snapshot
      // to avoid ~50 writes per compile pass.
      skipSnapshot: true,
    });
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
  // Single vault walk shared by every downstream pass below.
  const { records, summaries, parsedByPath, bytesByPath } =
    collectAllPageData(vaultPath);

  const rewrittenCount = refreshRelatedBlocks(
    vaultPath,
    summaries,
    parsedByPath,
  );
  const indexesRefreshed = refreshIndexes(vaultPath, summaries);

  // Project chronological timelines onto entity/person/company/project/
  // deal pages. Reuses parsedByPath so each page reads from memory
  // instead of bouncing off disk a second time.
  const timelineResult = projectTimelines(vaultPath, records, {
    parsedByPath,
  });

  // Reuse parsedByPath for digest building too.
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

  // Run lint inline and fold its summary into the digest so Janus sees
  // unlinked-mention and missing-attribution counts on every spawn
  // without re-running lint manually. The full report still lives at
  // reports/lint.md.
  const lintResult = await lintWiki(vaultPath);
  const missingAttributions =
    (lintResult.byCode['claim-missing-attribution'] || 0) +
    (lintResult.byCode['timeline-missing-attribution'] || 0);
  const unlinkedMentions = lintResult.byCode['unlinked-entity-mention'] || 0;

  // OpenClaw AgentDigest doesn't declare these additive fields — the
  // loose cast lets us inject them while downstream readers that don't
  // know about them just ignore the extras.
  const digestWithLint = digest as unknown as Record<string, unknown>;
  digestWithLint.lintSummary = {
    issueCount: lintResult.issueCount,
    errorCount: lintResult.bySeverity.error,
    warningCount: lintResult.bySeverity.warning,
    byCode: lintResult.byCode,
  };

  writeAgentDigest(vaultPath, digest);
  writeClaimsJsonl(vaultPath, buildClaimsJsonlLines(digestInputs));

  // Build the in-memory link graph from the SAME records the timeline
  // pass walked. Cache to disk only when the JSON actually changed so
  // we don't churn the bridge on every container spawn.
  const graph = buildGraph(records);
  writeGraphIndexIfChanged(vaultPath, graph);
  const graphNodes = Object.keys(graph.nodes).length;
  let graphEdges = 0;
  for (const arr of Object.values(graph.outEdges)) graphEdges += arr.length;

  // Volume metrics — pure measurement. Bytes come from the in-memory
  // bodies we already read; no statSync per page. Append + report
  // writes are diff-gated so identical compiles don't churn the bridge.
  const compileTimeMs = Date.now() - startedAt;
  let bytesMarkdown = 0;
  for (const n of bytesByPath.values()) bytesMarkdown += n;
  const metrics: VolumeMetrics = {
    ts: new Date().toISOString(),
    pageCount: summaries.length,
    claimCount: digest.claimCount,
    bytesMarkdown,
    compileTimeMs,
    lintTimeMs: lintResult.durationMs,
    pagesAdded30d: 0, // populated from log events when we wire it
  };
  appendMetricsSnapshotIfChanged(vaultPath, metrics);
  const volumeRecommendation = classifyAll(metrics);
  writeVolumeReportIfChanged(vaultPath, metrics, volumeRecommendation);

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
    timelinePagesRewritten: timelineResult.rewrittenCount,
    timelineEntriesTotal: timelineResult.entriesTotal,
    graphNodes,
    graphEdges,
    volumeLevel: volumeRecommendation.level,
    durationMs: Date.now() - startedAt,
  };

  appendWikiLogEvent(vaultPath, 'compile', { ...result });
  return result;
}
