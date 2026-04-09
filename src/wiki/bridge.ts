/**
 * Wiki bridge: pull memory files from configured paths into wiki sources/.
 *
 * Mirrors OpenClaw's `extensions/memory-wiki/src/bridge.ts` design:
 *   - Walks each configured source pattern
 *   - For each file: stat, compute fingerprint, check sync state
 *   - Skip if unchanged (cheap path — just stat + JSON read)
 *   - Otherwise: chunk via snippet-chunker, derive concept tags, write
 *     a sources/bridge-<slug>.md page wrapping the raw content
 *   - Prune sources whose original file is gone
 *   - Drop a `pending-ingest.json` marker if anything changed, so the
 *     next agent wake processes it
 *
 * The output `sources/bridge-*.md` pages are openclaw-compatible:
 *   pageType: source, sourceType: memory-bridge, full provenance frontmatter.
 */

import fs from 'fs';
import path from 'path';

import {
  BridgeArtifactKind,
  BridgeConfig,
  BridgeSourceConfig,
  ensureBridgeConfig,
} from './bridge-config.js';
import {
  computeRenderFingerprint,
  pruneImportedSourceEntries,
  readSourceSyncState,
  resolveArtifactKey,
  shouldSkipImportedSourceWrite,
  writeSourceSyncState,
} from './bridge-state.js';
import { compileWiki } from './compile.js';
import { deriveConceptTags } from './concept-tags.js';
import { appendWikiLogEvent } from './log.js';
import {
  serializeWikiPage,
  WikiPageFrontmatter,
} from './markdown.js';
import {
  buildDailySnippetChunks,
  renderSnippet,
} from './snippet-chunker.js';

const TEMPLATE_VERSION = 1;
const PENDING_INGEST_PATH = '.openclaw-wiki/pending-ingest.json';

export interface BridgeSyncResult {
  importedCount: number; // newly created
  updatedCount: number; // existed but changed
  skippedCount: number; // unchanged
  removedCount: number; // pruned
  errorCount: number;
  changedSourceIds: string[]; // page ids of imported|updated entries
  durationMs: number;
}

interface ResolvedSourceFile {
  sourceConfig: BridgeSourceConfig;
  absolutePath: string;
  relativePath: string; // relative to repo root
  basename: string;
  size: number;
  mtimeMs: number;
}

// =============================================================================
// File discovery
// =============================================================================

function matchGlob(filename: string, glob: string): boolean {
  // Convert glob to regex
  // Supports: * (no slash), ** (any), ? (single char), {a,b} alternation
  let re = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_m, alts) => `(?:${alts.split(',').join('|')})`)
    .replace(/\*\*/g, '\u0000DOUBLESTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000DOUBLESTAR\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + re + '$').test(filename);
}

function walkDirectory(root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function resolveSourceFiles(
  sourceConfig: BridgeSourceConfig,
  repoRoot: string,
): ResolvedSourceFile[] {
  const root = path.resolve(repoRoot, sourceConfig.rootPath);
  if (!fs.existsSync(root)) return [];

  const allFiles = walkDirectory(root);
  const resolved: ResolvedSourceFile[] = [];

  for (const absPath of allFiles) {
    const relativeToRoot = path.relative(root, absPath).replace(/\\/g, '/');
    if (!matchGlob(relativeToRoot, sourceConfig.glob)) continue;
    if (
      sourceConfig.exclude?.some((pattern) => matchGlob(relativeToRoot, pattern))
    ) {
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (
      sourceConfig.maxFileSizeBytes &&
      stat.size > sourceConfig.maxFileSizeBytes
    ) {
      continue;
    }
    const repoRelative = path.relative(repoRoot, absPath).replace(/\\/g, '/');
    resolved.push({
      sourceConfig,
      absolutePath: absPath,
      relativePath: repoRelative,
      basename: path.basename(absPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }

  return resolved;
}

// =============================================================================
// Page rendering
// =============================================================================

function buildBridgeSlug(sourceConfig: BridgeSourceConfig, file: ResolvedSourceFile): string {
  const sourcePart = sourceConfig.id;
  const namePart = file.relativePath
    .replace(/\.[^/.]+$/, '') // strip extension
    .replace(/[/\\]/g, '-')
    .replace(/[^\w-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${sourcePart}--${namePart}`.toLowerCase();
}

function buildBridgePageId(slug: string): string {
  return `source.${slug}`;
}

function buildBridgePagePath(slug: string): string {
  return path.join('sources', `bridge-${slug}.md`);
}

function buildBridgeFrontmatter(params: {
  pageId: string;
  title: string;
  sourceConfig: BridgeSourceConfig;
  file: ResolvedSourceFile;
  conceptTags: string[];
  ingestedAt: string;
}): WikiPageFrontmatter {
  return {
    id: params.pageId,
    pageType: 'source',
    title: params.title,
    sourceIds: [],
    claims: [],
    contradictions: [],
    questions: [],
    confidence: 0.7,
    status: 'active',
    updatedAt: params.ingestedAt,
    sourceType: kindToSourceType(params.sourceConfig.kind),
    sourcePath: params.file.absolutePath,
    bridgeRelativePath: params.file.relativePath,
    bridgeWorkspaceDir: process.cwd(),
    bridgeAgentIds: params.sourceConfig.agentIds || [],
    ingestedAt: params.ingestedAt,
    conceptTags: params.conceptTags,
    bridgeKind: params.sourceConfig.kind,
    bridgeSourceId: params.sourceConfig.id,
  };
}

function kindToSourceType(kind: BridgeArtifactKind): string {
  switch (kind) {
    case 'memory-root':
      return 'memory-bridge-root';
    case 'daily-note':
      return 'memory-bridge';
    case 'dream-report':
      return 'memory-bridge-dream';
    case 'event-log':
      return 'memory-bridge-events';
    case 'user-context':
      return 'memory-bridge-user-context';
  }
}

function renderBridgeBody(params: {
  file: ResolvedSourceFile;
  rawContent: string;
  conceptTags: string[];
}): string {
  const lines: string[] = [];

  // Metadata table
  lines.push('## Bridge Source\n');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Source path | \`${params.file.relativePath}\` |`);
  lines.push(`| Bridged kind | \`${params.file.sourceConfig.kind}\` |`);
  lines.push(`| Source bytes | ${params.file.size} |`);
  lines.push(
    `| Source modified | ${new Date(params.file.mtimeMs).toISOString()} |`,
  );
  if (params.conceptTags.length > 0) {
    lines.push(`| Concept tags | ${params.conceptTags.map((t) => `\`${t}\``).join(', ')} |`);
  }
  lines.push('');

  // Snippet chunks (only for daily-note kind — other kinds get raw content)
  if (
    params.file.sourceConfig.kind === 'daily-note' ||
    params.file.sourceConfig.kind === 'dream-report'
  ) {
    const chunks = buildDailySnippetChunks(params.rawContent);
    if (chunks.length > 0) {
      lines.push('## Snippets\n');
      for (const chunk of chunks) {
        lines.push(renderSnippet(chunk));
      }
      lines.push('');
    }
  }

  // Raw content fenced
  lines.push('## Content\n');
  lines.push('```markdown');
  lines.push(params.rawContent.trimEnd());
  lines.push('```');
  lines.push('');

  // Human notes block (preserved across re-renders since it's part of the template)
  lines.push('## Notes\n');
  lines.push('<!-- openclaw:human:start -->');
  lines.push('');
  lines.push('<!-- openclaw:human:end -->');
  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// Main sync function
// =============================================================================

export async function syncWikiBridge(
  vaultPath: string,
  repoRoot: string,
): Promise<BridgeSyncResult> {
  const startedAt = Date.now();
  const result: BridgeSyncResult = {
    importedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    removedCount: 0,
    errorCount: 0,
    changedSourceIds: [],
    durationMs: 0,
  };

  const config = ensureBridgeConfig(vaultPath);
  const state = readSourceSyncState(vaultPath);
  const ingestedAt = new Date().toISOString();
  const activeKeys = new Set<string>();

  for (const sourceConfig of config.sources) {
    const files = resolveSourceFiles(sourceConfig, repoRoot);

    for (const file of files) {
      const syncKey = resolveArtifactKey(file.absolutePath);
      activeKeys.add(syncKey);

      const slug = buildBridgeSlug(sourceConfig, file);
      const pageId = buildBridgePageId(slug);
      const pageRelativePath = buildBridgePagePath(slug);

      const renderFingerprint = computeRenderFingerprint({
        artifactKind: sourceConfig.kind,
        sourceRelativePath: file.relativePath,
        agentIds: sourceConfig.agentIds || [],
        templateVersion: TEMPLATE_VERSION,
      });

      const skip = shouldSkipImportedSourceWrite({
        vaultPath,
        state,
        syncKey,
        expectedPagePath: pageRelativePath,
        sourcePath: file.absolutePath,
        sourceUpdatedAtMs: file.mtimeMs,
        sourceSize: file.size,
        renderFingerprint,
      });

      if (skip) {
        result.skippedCount++;
        continue;
      }

      // Re-render
      let rawContent: string;
      try {
        rawContent = fs.readFileSync(file.absolutePath, 'utf-8');
      } catch {
        result.errorCount++;
        continue;
      }

      const conceptTags =
        sourceConfig.kind === 'daily-note' ||
        sourceConfig.kind === 'dream-report'
          ? deriveConceptTags(rawContent)
          : [];

      const title = `Bridge: ${file.relativePath}`;
      const frontmatter = buildBridgeFrontmatter({
        pageId,
        title,
        sourceConfig,
        file,
        conceptTags,
        ingestedAt,
      });
      const body = renderBridgeBody({ file, rawContent, conceptTags });
      const pageContent = serializeWikiPage(frontmatter, body);

      const fullPagePath = path.join(vaultPath, pageRelativePath);
      const wasNew = !fs.existsSync(fullPagePath);

      try {
        fs.mkdirSync(path.dirname(fullPagePath), { recursive: true });
        const tempPath = `${fullPagePath}.tmp`;
        fs.writeFileSync(tempPath, pageContent);
        fs.renameSync(tempPath, fullPagePath);
      } catch {
        result.errorCount++;
        continue;
      }

      // Update state entry
      state.entries[syncKey] = {
        group: 'bridge',
        pagePath: pageRelativePath,
        sourcePath: file.absolutePath,
        sourceUpdatedAtMs: file.mtimeMs,
        sourceSize: file.size,
        renderFingerprint,
      };

      if (wasNew) result.importedCount++;
      else result.updatedCount++;
      result.changedSourceIds.push(pageId);
    }
  }

  // Prune dead entries
  result.removedCount = pruneImportedSourceEntries({
    vaultPath,
    group: 'bridge',
    activeKeys,
    state,
  });

  writeSourceSyncState(vaultPath, state);

  // Drop pending-ingest marker if anything changed
  if (
    result.changedSourceIds.length > 0 ||
    result.removedCount > 0
  ) {
    writePendingIngestMarker(vaultPath, {
      ts: ingestedAt,
      changedSourceIds: result.changedSourceIds,
      importedCount: result.importedCount,
      updatedCount: result.updatedCount,
      removedCount: result.removedCount,
    });
  }

  // Auto-compile if anything changed and config opts in
  if (
    config.ingest.autoCompile &&
    (result.changedSourceIds.length > 0 || result.removedCount > 0)
  ) {
    try {
      await compileWiki(vaultPath);
    } catch {
      // compile failure must not break bridge sync
    }
  }

  result.durationMs = Date.now() - startedAt;

  appendWikiLogEvent(vaultPath, 'bridge-sync', {
    ...result,
    sourceConfigCount: config.sources.length,
  });

  return result;
}

// =============================================================================
// Pending-ingest marker
// =============================================================================

export interface PendingIngestMarker {
  ts: string;
  changedSourceIds: string[];
  importedCount: number;
  updatedCount: number;
  removedCount: number;
}

export function getPendingIngestPath(vaultPath: string): string {
  return path.join(vaultPath, PENDING_INGEST_PATH);
}

export function writePendingIngestMarker(
  vaultPath: string,
  marker: PendingIngestMarker,
): void {
  const p = getPendingIngestPath(vaultPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(marker, null, 2) + '\n');
}

export function readPendingIngestMarker(
  vaultPath: string,
): PendingIngestMarker | null {
  const p = getPendingIngestPath(vaultPath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as PendingIngestMarker;
  } catch {
    return null;
  }
}

export function clearPendingIngestMarker(vaultPath: string): void {
  const p = getPendingIngestPath(vaultPath);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
  }
}
