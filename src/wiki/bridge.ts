/**
 * Bridge memory files into wiki sources/.
 *
 * Cheap on the no-op path: just stats every configured file, compares
 * (mtime, size, fingerprint) against `.openclaw-wiki/source-sync.json`,
 * skips unchanged. Only on a real change does it read+chunk+rewrite.
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
  readPullSourceState,
  readSourceSyncState,
  resolveArtifactKey,
  shouldSkipImportedSourceWrite,
  writePullSourceState,
  writeSourceSyncState,
} from './bridge-state.js';
import { compileWiki } from './compile.js';
import { deriveConceptTags } from './concept-tags.js';
import {
  buildReferenceOnlyContent,
  ExtractedContent,
  ExtractorInput,
} from './extractors/base.js';
import {
  FieldtheoryBookmarkSummary,
  listFieldtheoryBookmarks,
} from './extractors/fieldtheory.js';
import { getDefaultRegistry } from './extractors/registry.js';
import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import { appendWikiLogEvent } from './log.js';
import { serializeWikiPage, WikiPageFrontmatter } from './markdown.js';
import { vaultPaths } from './paths.js';
import { buildDailySnippetChunks, renderSnippet } from './snippet-chunker.js';

const TEMPLATE_VERSION = 1;

export interface BridgeSyncError {
  path: string;
  op: string;
  message: string;
}

export interface BridgeSyncResult {
  importedCount: number; // newly created
  updatedCount: number; // existed but changed
  skippedCount: number; // unchanged
  removedCount: number; // pruned
  errorCount: number;
  errors: BridgeSyncError[];
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

// Always-pruned directory names. Skipping these at the dirent level prevents
// the bridge from walking its own output (the wiki vault), .git, node_modules,
// or its own state directory — which would otherwise self-scale badly as the
// vault grew (every spawn would re-walk every previously-bridged page).
const ALWAYS_PRUNE = new Set([
  '.git',
  '.openclaw-wiki',
  'node_modules',
  '.next',
  'dist',
  'build',
  '__pycache__',
]);

// Compile a glob pattern to a regex once. Cached at module scope so the same
// pattern across many files reuses the same RegExp.
const globRegexCache = new Map<string, RegExp>();
function compileGlob(glob: string): RegExp {
  const cached = globRegexCache.get(glob);
  if (cached) {
    cached.lastIndex = 0;
    return cached;
  }
  // Convert glob to regex. Supports * (no slash), ** (any incl slashes),
  // ? (single char), {a,b} alternation. Uses a sentinel for ** so the
  // single-* replacement doesn't eat double-star.
  const escaped = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{([^}]+)\}/g, (_m, alts) => `(?:${alts.split(',').join('|')})`)
    .replace(/\*\*/g, '\u0000DOUBLESTAR\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000DOUBLESTAR\u0000\//g, '(?:.*/)?') // **/ — zero or more dirs
    .replace(/\u0000DOUBLESTAR\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  const re = new RegExp('^' + escaped + '$');
  globRegexCache.set(glob, re);
  return re;
}

function matchGlob(filename: string, glob: string): boolean {
  return compileGlob(glob).test(filename);
}

/**
 * Walk a directory tree. The prune predicate is checked per-dirent so we
 * skip pruned directories before recursing into them — meaningfully cheaper
 * than walking everything and filtering at the file level.
 */
function walkDirectory(
  root: string,
  prune: (dirRelativePath: string) => boolean = () => false,
): string[] {
  const results: string[] = [];
  if (!fs.existsSync(root)) return results;
  const stack: { abs: string; rel: string }[] = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ALWAYS_PRUNE.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (prune(childRel)) continue;
        stack.push({ abs: childAbs, rel: childRel });
      } else if (entry.isFile()) {
        results.push(childAbs);
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

  // Hoist glob compilation per-source-config — one regex per pattern, reused
  // across every file we test.
  const includeRe = compileGlob(sourceConfig.glob);
  const excludeRes = (sourceConfig.exclude || []).map(compileGlob);

  // Prune known noisy subtrees during the walk. The wiki-inbox subtree is
  // especially important: without this, every wiki page the bridge wrote
  // would be re-walked as a candidate source on the next sync.
  const pruneSubtree = (rel: string): boolean => {
    if (rel.includes('telegram_wiki-inbox')) return true;
    return excludeRes.some((re) => {
      re.lastIndex = 0;
      return re.test(rel);
    });
  };

  const allFiles = walkDirectory(root, pruneSubtree);
  const resolved: ResolvedSourceFile[] = [];

  for (const absPath of allFiles) {
    const relativeToRoot = path.relative(root, absPath).replace(/\\/g, '/');
    includeRe.lastIndex = 0;
    if (!includeRe.test(relativeToRoot)) continue;
    if (
      excludeRes.some((re) => {
        re.lastIndex = 0;
        return re.test(relativeToRoot);
      })
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

function buildBridgeSlug(
  sourceConfig: BridgeSourceConfig,
  file: ResolvedSourceFile,
): string {
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
  file: ResolvedSourceFile;
  conceptTags: string[];
  ingestedAt: string;
  repoRoot: string;
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
    sourceType: kindToSourceType(params.file.sourceConfig.kind),
    sourcePath: params.file.relativePath,
    bridgeRelativePath: params.file.relativePath,
    bridgeWorkspaceDir: params.repoRoot,
    bridgeAgentIds: params.file.sourceConfig.agentIds || [],
    ingestedAt: params.ingestedAt,
    conceptTags: params.conceptTags,
    bridgeKind: params.file.sourceConfig.kind,
    bridgeSourceId: params.file.sourceConfig.id,
  };
}

const SOURCE_TYPE_BY_KIND: Record<BridgeArtifactKind, string> = {
  'memory-root': 'memory-bridge-root',
  'daily-note': 'memory-bridge',
  'dream-report': 'memory-bridge-dream',
  'event-log': 'memory-bridge-events',
  'user-context': 'memory-bridge-user-context',
  'extracted-asset': 'extracted-asset',
};

/**
 * Files whose extension is in MARKDOWN_EXTS stay on the legacy markdown
 * path (read → snippet → fence). Everything else routes through the
 * extractor registry. This preserves existing bridge behavior for the
 * default config (which only globs `*.md`) and lets users opt in to
 * extracted assets by adding a broader glob.
 */
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

function isMarkdownFile(relativePath: string): boolean {
  return MARKDOWN_EXTS.has(path.extname(relativePath).toLowerCase());
}

function kindToSourceType(kind: BridgeArtifactKind): string {
  return SOURCE_TYPE_BY_KIND[kind];
}

const KINDS_WITH_SNIPPETS = new Set<BridgeArtifactKind>([
  'daily-note',
  'dream-report',
]);

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
    lines.push(
      `| Concept tags | ${params.conceptTags.map((t) => `\`${t}\``).join(', ')} |`,
    );
  }
  lines.push('');

  if (KINDS_WITH_SNIPPETS.has(params.file.sourceConfig.kind)) {
    const chunks = buildDailySnippetChunks(params.rawContent);
    if (chunks.length > 0) {
      lines.push('## Snippets\n');
      for (const chunk of chunks) {
        lines.push(renderSnippet(chunk));
      }
      lines.push('');
    }
  }

  // Raw content. Use a fence longer than any run of backticks already
  // present in the source so embedded markdown fences don't escape ours.
  const longestRun = (params.rawContent.match(/`+/g) || []).reduce(
    (max, s) => Math.max(max, s.length),
    0,
  );
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  lines.push('## Content\n');
  lines.push(`${fence}markdown`);
  lines.push(params.rawContent.trimEnd());
  lines.push(fence);
  lines.push('');

  // Note: this whole body is regenerated on every bridge sync. The Notes
  // block is part of the template — human edits in here are NOT preserved.
  // To preserve notes, write a separate page that links to this source.
  lines.push('## Notes\n');
  lines.push('<!-- openclaw:human:start -->');
  lines.push('');
  lines.push('<!-- openclaw:human:end -->');
  lines.push('');

  return lines.join('\n');
}

// =============================================================================
// Phase 2.5: extracted assets — unified source page template
// =============================================================================

/**
 * Render the unified body for any ExtractedContent. Every source page —
 * PDF, YouTube, web article, tweet, image, bookmark — uses this shape so
 * Janus treats them identically.
 */
function renderExtractedBody(params: {
  content: ExtractedContent;
  originalReference: string;
}): string {
  const lines: string[] = [];

  lines.push('## Source\n');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Title | ${escapeMarkdownTableCell(params.content.title)} |`);
  lines.push(
    `| Extractor | \`${params.content.extractorName}@${params.content.extractorVersion}\` |`,
  );
  lines.push(`| Extracted at | ${params.content.extractedAt} |`);
  lines.push(`| Mime type | \`${params.content.mimeType}\` |`);
  lines.push(`| Original | ${params.originalReference} |`);
  lines.push('');

  // Determine heading for the body payload. Transcripts from video get
  // `## Transcript`; everything else gets `## Content`. This is purely
  // cosmetic but helps Janus scan pages at a glance.
  const bodyHeading =
    params.content.mimeType === 'video/youtube'
      ? '## Transcript'
      : '## Content';
  lines.push(bodyHeading + '\n');
  lines.push(params.content.body.trim());
  lines.push('');

  // Notes block preserved across re-extraction via the same managed-block
  // mechanism as the markdown bridge. Anything between the markers is
  // rewritten by the NEXT extraction run — treat as ephemeral. Janus
  // should promote persistent notes to a new wiki page.
  lines.push('## Notes\n');
  lines.push('<!-- openclaw:human:start -->');
  lines.push('');
  lines.push('<!-- openclaw:human:end -->');
  lines.push('');

  return lines.join('\n');
}

function escapeMarkdownTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function buildExtractedFrontmatter(params: {
  pageId: string;
  file: ResolvedSourceFile;
  content: ExtractedContent;
  ingestedAt: string;
  repoRoot: string;
}): WikiPageFrontmatter {
  return {
    id: params.pageId,
    pageType: 'source',
    title: params.content.title,
    sourceIds: [],
    claims: [],
    contradictions: [],
    questions: [],
    confidence: 0.7,
    status: 'active',
    updatedAt: params.ingestedAt,
    sourceType: 'extracted-asset',
    sourcePath: params.file.relativePath,
    bridgeRelativePath: params.file.relativePath,
    bridgeWorkspaceDir: params.repoRoot,
    bridgeAgentIds: params.file.sourceConfig.agentIds || [],
    ingestedAt: params.ingestedAt,
    bridgeKind: params.file.sourceConfig.kind,
    bridgeSourceId: params.file.sourceConfig.id,
    extractorName: params.content.extractorName,
    extractorVersion: params.content.extractorVersion,
    extractedAt: params.content.extractedAt,
    extractorMimeType: params.content.mimeType,
    extractorMetadata: params.content.metadata,
    ...(params.content.originalUrl && {
      originalUrl: params.content.originalUrl,
    }),
  };
}

/**
 * Build a pure-virtual ResolvedSourceFile for a pull-source bookmark.
 * Pull sources have no real file on disk — we synthesise the path from
 * the source id + bookmark id so downstream slug/key logic works.
 *
 * `mtimeMs` MUST be stable across runs (not Date.now()) — otherwise
 * the bridge's shouldSkipImportedSourceWrite check fails on every run
 * and we re-extract every bookmark every time. We use the bookmark's
 * own `bookmarkedAt` if present, otherwise 0.
 */
function syntheticResolvedFileForBookmark(params: {
  sourceConfig: BridgeSourceConfig;
  bookmarkId: string;
  repoRoot: string;
  bookmarkedAtMs: number;
}): ResolvedSourceFile {
  const virtualRelative = `${params.sourceConfig.id}/${params.bookmarkId}`;
  return {
    sourceConfig: params.sourceConfig,
    absolutePath: `pull://${virtualRelative}`,
    relativePath: virtualRelative,
    basename: params.bookmarkId,
    size: 0,
    mtimeMs: params.bookmarkedAtMs,
  };
}

/**
 * Single unified writer for any extracted source page — used by both
 * the file-glob path (PDFs, images, etc.) and pull sources (fieldtheory).
 *
 * Routes the extractor ONCE, reuses the matched instance for both the
 * fingerprint and the extract call, catches extractor throws and falls
 * back to a reference-only stub. Writes atomically, mutates `state` +
 * `result` in place, records log entries.
 */
async function writeExtractedSourcePage(params: {
  file: ResolvedSourceFile;
  input: ExtractorInput;
  pageId: string;
  pageRelativePath: string;
  syncKey: string;
  vaultPath: string;
  repoRoot: string;
  state: ReturnType<typeof readSourceSyncState>;
  result: BridgeSyncResult;
  ingestedAt: string;
  /** Anything to merge into the extracted frontmatter (e.g., ft metadata). */
  frontmatterExtras?: Record<string, unknown>;
  /** Overrides the default `` `relativePath` `` citation in the body. */
  originalReference?: string;
}): Promise<void> {
  const {
    file,
    input,
    pageId,
    pageRelativePath,
    syncKey,
    vaultPath,
    repoRoot,
    state,
    result,
    ingestedAt,
    frontmatterExtras,
    originalReference,
  } = params;

  // Route ONCE. Previously the bridge routed twice: once for the
  // fingerprint and once inside `registry.extract`. We keep the
  // extractor reference and call `.extract()` directly so the second
  // walk disappears.
  const registry = getDefaultRegistry();
  const extractor = registry.route(input);

  const renderFingerprint = computeRenderFingerprint({
    artifactKind: file.sourceConfig.kind,
    sourceRelativePath: file.relativePath,
    agentIds: file.sourceConfig.agentIds || [],
    templateVersion: TEMPLATE_VERSION,
    extractor: extractor
      ? { name: extractor.name, version: extractor.version }
      : { name: 'reference-only', version: '1' },
  });

  if (
    shouldSkipImportedSourceWrite({
      vaultPath,
      state,
      syncKey,
      expectedPagePath: pageRelativePath,
      sourcePath: file.relativePath,
      sourceUpdatedAtMs: file.mtimeMs,
      sourceSize: file.size,
      renderFingerprint,
    })
  ) {
    result.skippedCount++;
    return;
  }

  let content: ExtractedContent;
  if (!extractor) {
    content = buildReferenceOnlyContent({
      input,
      reason: 'no extractor matched input',
    });
  } else {
    try {
      content = await extractor.extract(input);
    } catch (err) {
      content = buildReferenceOnlyContent({
        input,
        reason: (err as Error).message ?? 'extractor threw',
        attemptedExtractor: extractor.name,
      });
    }
  }

  const frontmatter = buildExtractedFrontmatter({
    pageId,
    file,
    content,
    ingestedAt,
    repoRoot,
  });
  if (frontmatterExtras) Object.assign(frontmatter, frontmatterExtras);

  const body = renderExtractedBody({
    content,
    originalReference: originalReference ?? `\`${file.relativePath}\``,
  });
  const pageContent = serializeWikiPage(frontmatter, body);

  const fullPagePath = path.join(vaultPath, pageRelativePath);
  const wasNew = !fs.existsSync(fullPagePath);

  try {
    atomicWriteFile(fullPagePath, pageContent);
  } catch (err) {
    result.errorCount++;
    result.errors.push({
      path: pageRelativePath,
      op: 'write-extracted-page',
      message: (err as Error).message,
    });
    return;
  }

  state.entries[syncKey] = {
    group: 'bridge',
    pagePath: pageRelativePath,
    sourcePath: file.relativePath,
    sourceUpdatedAtMs: file.mtimeMs,
    sourceSize: file.size,
    renderFingerprint,
  };

  if (wasNew) result.importedCount++;
  else result.updatedCount++;
  result.changedSourceIds.push(pageId);
}

async function processExtractedAsset(params: {
  file: ResolvedSourceFile;
  vaultPath: string;
  repoRoot: string;
  syncKey: string;
  slug: string;
  pageId: string;
  pageRelativePath: string;
  state: ReturnType<typeof readSourceSyncState>;
  result: BridgeSyncResult;
  ingestedAt: string;
}): Promise<void> {
  return writeExtractedSourcePage({
    file: params.file,
    input: { kind: 'file', path: params.file.absolutePath },
    pageId: params.pageId,
    pageRelativePath: params.pageRelativePath,
    syncKey: params.syncKey,
    vaultPath: params.vaultPath,
    repoRoot: params.repoRoot,
    state: params.state,
    result: params.result,
    ingestedAt: params.ingestedAt,
  });
}

async function processPullSource(params: {
  sourceConfig: BridgeSourceConfig;
  vaultPath: string;
  repoRoot: string;
  state: ReturnType<typeof readSourceSyncState>;
  activeKeys: Set<string>;
  result: BridgeSyncResult;
  ingestedAt: string;
}): Promise<void> {
  const {
    sourceConfig,
    vaultPath,
    repoRoot,
    state,
    activeKeys,
    result,
    ingestedAt,
  } = params;

  // First (and only) pull extractor wired in Phase 2.5 is fieldtheory.
  // Add more by dispatching on `sourceConfig.pullExtractorName`.
  if (sourceConfig.pullExtractorName !== 'fieldtheory') {
    result.errors.push({
      path: sourceConfig.id,
      op: 'pull-source',
      message: `unknown pullExtractorName: ${sourceConfig.pullExtractorName}`,
    });
    result.errorCount++;
    return;
  }

  const pullState = readPullSourceState(state, sourceConfig.id);
  let bookmarks: FieldtheoryBookmarkSummary[];
  try {
    bookmarks = await listFieldtheoryBookmarks(pullState.lastSyncAt);
  } catch (err) {
    result.errors.push({
      path: sourceConfig.id,
      op: 'ft-list',
      message: (err as Error).message,
    });
    result.errorCount++;
    return;
  }

  // Pull sources keep cumulative state — `lastSyncAt` filters NEW
  // bookmarks but everything previously imported is still owned by
  // this source. Mark every prior pull-state entry as still-active so
  // the prune step at the end of syncWikiBridge doesn't delete the
  // 900+ pages we wrote on a previous run. Relative sourcePath
  // convention for pull entries: `<source-id>/<bookmark-id>` (no
  // `pull://` prefix).
  const sourceIdPrefix = `${sourceConfig.id}/`;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (entry.sourcePath.startsWith(sourceIdPrefix)) {
      activeKeys.add(key);
    }
  }

  for (const bookmark of bookmarks) {
    // Stable mtime: prefer the bookmark's bookmarkedAt; fall back to 0.
    const bookmarkedAtMs = bookmark.bookmarkedAt
      ? Date.parse(bookmark.bookmarkedAt) || 0
      : 0;
    const virtualFile = syntheticResolvedFileForBookmark({
      sourceConfig,
      bookmarkId: bookmark.id,
      repoRoot,
      bookmarkedAtMs,
    });
    const syncKey = resolveArtifactKey(virtualFile.relativePath);
    activeKeys.add(syncKey);

    const slug = buildBridgeSlug(sourceConfig, virtualFile);
    const pageId = buildBridgePageId(slug);
    const pageRelativePath = buildBridgePagePath(slug);

    // ft-specific frontmatter extras so Phase 3 hub routing can read
    // category/domain/author off the page.
    const extras: Record<string, unknown> = {};
    if (bookmark.category) extras.ftCategory = bookmark.category;
    if (bookmark.domain) extras.ftDomain = bookmark.domain;
    if (bookmark.author) extras.ftAuthor = bookmark.author;

    await writeExtractedSourcePage({
      file: virtualFile,
      input: { kind: 'bookmark-id', bookmarkId: `ft:${bookmark.id}` },
      pageId,
      pageRelativePath,
      syncKey,
      vaultPath,
      repoRoot,
      state,
      result,
      ingestedAt,
      frontmatterExtras: extras,
      originalReference: bookmark.url
        ? `[${bookmark.url}](${bookmark.url})`
        : '(no url)',
    });
  }

  // Advance the pull cursor so the next run starts from ingestedAt.
  writePullSourceState(state, sourceConfig.id, {
    lastSyncAt: ingestedAt,
    lastExtractorVersion: '1',
    lastBookmarkCount: bookmarks.length,
  });
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
    errors: [],
    changedSourceIds: [],
    durationMs: 0,
  };

  const config = ensureBridgeConfig(vaultPath);
  const state = readSourceSyncState(vaultPath);
  const ingestedAt = new Date().toISOString();
  const activeKeys = new Set<string>();

  for (const sourceConfig of config.sources) {
    // Phase 2.5: pull sources fetch from an external command on a
    // schedule rather than walking the filesystem. Fieldtheory is the
    // first user; the handler is generic over extractors.
    if (sourceConfig.sourceType === 'pull') {
      await processPullSource({
        sourceConfig,
        vaultPath,
        repoRoot,
        state,
        activeKeys,
        result,
        ingestedAt,
      });
      continue;
    }

    const files = resolveSourceFiles(sourceConfig, repoRoot);

    for (const file of files) {
      const syncKey = resolveArtifactKey(file.relativePath);
      activeKeys.add(syncKey);

      const slug = buildBridgeSlug(sourceConfig, file);
      const pageId = buildBridgePageId(slug);
      const pageRelativePath = buildBridgePagePath(slug);

      // Phase 2.5: non-markdown files go through the extractor registry.
      // Markdown stays on the legacy path so the default vault is unchanged.
      if (!isMarkdownFile(file.relativePath)) {
        await processExtractedAsset({
          file,
          vaultPath,
          repoRoot,
          syncKey,
          slug,
          pageId,
          pageRelativePath,
          state,
          result,
          ingestedAt,
        });
        continue;
      }

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
        sourcePath: file.relativePath,
        sourceUpdatedAtMs: file.mtimeMs,
        sourceSize: file.size,
        renderFingerprint,
      });

      if (skip) {
        result.skippedCount++;
        continue;
      }

      let rawContent: string;
      try {
        rawContent = fs.readFileSync(file.absolutePath, 'utf-8');
      } catch (err) {
        result.errorCount++;
        result.errors.push({
          path: file.relativePath,
          op: 'read-source',
          message: (err as Error).message,
        });
        continue;
      }

      const conceptTags = KINDS_WITH_SNIPPETS.has(sourceConfig.kind)
        ? deriveConceptTags(rawContent, config.conceptTagStopwords)
        : [];

      const title = `Bridge: ${file.relativePath}`;
      const frontmatter = buildBridgeFrontmatter({
        pageId,
        title,
        file,
        conceptTags,
        ingestedAt,
        repoRoot,
      });
      const body = renderBridgeBody({ file, rawContent, conceptTags });
      const pageContent = serializeWikiPage(frontmatter, body);

      const fullPagePath = path.join(vaultPath, pageRelativePath);
      const wasNew = !fs.existsSync(fullPagePath);

      try {
        atomicWriteFile(fullPagePath, pageContent);
      } catch (err) {
        result.errorCount++;
        result.errors.push({
          path: pageRelativePath,
          op: 'write-page',
          message: (err as Error).message,
        });
        continue;
      }

      state.entries[syncKey] = {
        group: 'bridge',
        pagePath: pageRelativePath,
        sourcePath: file.relativePath,
        sourceUpdatedAtMs: file.mtimeMs,
        sourceSize: file.size,
        renderFingerprint,
      };

      if (wasNew) result.importedCount++;
      else result.updatedCount++;
      result.changedSourceIds.push(pageId);
    }
  }

  result.removedCount = pruneImportedSourceEntries({
    vaultPath,
    group: 'bridge',
    activeKeys,
    state,
  });

  const stateChanged =
    result.changedSourceIds.length > 0 || result.removedCount > 0;

  // Skip the state file rewrite on a true no-op — saves two syscalls per
  // container spawn on the cheap path. The on-disk state is already correct.
  if (stateChanged) {
    writeSourceSyncState(vaultPath, state);
    writePendingIngestMarker(vaultPath, {
      ts: ingestedAt,
      changedSourceIds: result.changedSourceIds,
      importedCount: result.importedCount,
      updatedCount: result.updatedCount,
      removedCount: result.removedCount,
    });
  }

  if (config.ingest.autoCompile && stateChanged) {
    try {
      await compileWiki(vaultPath);
    } catch {
      // compile failure must not break bridge sync
    }
  }

  result.durationMs = Date.now() - startedAt;

  // Only log on actual changes or errors. A no-op spawn shouldn't grow the
  // log file. Cap the changedSourceIds list so the line stays under PIPE_BUF.
  if (stateChanged || result.errorCount > 0) {
    const MAX_LOGGED_IDS = 20;
    const loggedIds = result.changedSourceIds.slice(0, MAX_LOGGED_IDS);
    const overflow = result.changedSourceIds.length - loggedIds.length;
    appendWikiLogEvent(vaultPath, 'bridge-sync', {
      importedCount: result.importedCount,
      updatedCount: result.updatedCount,
      skippedCount: result.skippedCount,
      removedCount: result.removedCount,
      errorCount: result.errorCount,
      changedSourceIds: loggedIds,
      ...(overflow > 0 && { changedSourceIdsOverflow: overflow }),
      durationMs: result.durationMs,
      sourceConfigCount: config.sources.length,
      ...(result.errors.length > 0 && {
        errors: result.errors.slice(0, 5),
      }),
    });
  }

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
  return vaultPaths(vaultPath).pendingIngest;
}

export function writePendingIngestMarker(
  vaultPath: string,
  marker: PendingIngestMarker,
): void {
  atomicWriteFile(
    getPendingIngestPath(vaultPath),
    JSON.stringify(marker, null, 2) + '\n',
  );
}

export function readPendingIngestMarker(
  vaultPath: string,
): PendingIngestMarker | null {
  return readJsonOrDefault<PendingIngestMarker | null>(
    getPendingIngestPath(vaultPath),
    null,
  );
}

export function clearPendingIngestMarker(vaultPath: string): void {
  const p = getPendingIngestPath(vaultPath);
  if (fs.existsSync(p)) {
    fs.rmSync(p);
  }
}
