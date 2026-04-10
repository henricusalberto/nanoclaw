/**
 * Operation contract registry.
 *
 * Single source of truth for every read/write primitive the wiki
 * exposes. Each operation has a name, a short description, an input
 * shape, and a handler that takes `(vaultPath, input)` and returns
 * a result.
 *
 * The handlers are thin wrappers over existing pure functions
 * (graph.ts, versions.ts, slug-resolver.ts, markdown.ts, etc). This
 * module adds NO new capability — it's a typed facade. The win is
 * having one place that enumerates every wiki verb, so the CLI
 * subcommand `wiki op <name> <json-input>`, future MCP tool
 * exposure, or a future programmatic agent interface can all
 * dispatch through the same table.
 *
 * Design rules:
 *  - Operations are stateless from the caller's perspective: all
 *    context lives under `vaultPath`.
 *  - Inputs and outputs are JSON-serializable.
 *  - Errors throw — the CLI wrapper catches and pretty-prints.
 *  - Versioning is implicit: adding a new op is additive. Removing
 *    or renaming an op is a breaking change.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import {
  buildGraph,
  computeBacklinks,
  neighbors,
  readGraphIndex,
  shortestPath,
  traverse,
} from './graph.js';
import {
  parseWikiPage,
  serializeWikiPage,
  WikiPageFrontmatter,
  writeWikiPage,
} from './markdown.js';
import { vaultPaths } from './paths.js';
import { resolveSlug } from './slug-resolver.js';
import { collectVaultPages, VaultPageRecord } from './vault-walk.js';
import { listVersions, readVersion, revertToVersion } from './versions.js';

export interface OperationContract<I, O> {
  name: string;
  description: string;
  handler: (vaultPath: string, input: I) => Promise<O> | O;
}

// =============================================================================
// Operation input/output types
// =============================================================================

export interface GetPageInput {
  slug: string;
}
export interface GetPageOutput {
  relativePath: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
}

export interface PutPageInput {
  relativePath: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
  writtenBy?: string;
  reason?: string;
}
export interface PutPageOutput {
  relativePath: string;
  bytesWritten: number;
}

export interface ListPagesInput {
  dir?: string;
  kind?: string;
}
export interface ListPagesOutput {
  pages: Array<{
    slug: string;
    relativePath: string;
    title: string;
    kind: string;
  }>;
}

export interface SearchInput {
  query: string;
  limit?: number;
}
export interface SearchOutput {
  results: Array<{
    slug: string;
    relativePath: string;
    title: string;
    snippet: string;
    score: number;
  }>;
}

export interface GetBacklinksInput {
  slug: string;
}
export interface GetBacklinksOutput {
  backlinks: string[];
}

export interface TraverseGraphInput {
  start: string;
  maxDepth?: number;
}
export interface TraverseGraphOutput {
  visited: Array<{ basename: string; depth: number }>;
}

export interface ResolveSlugInput {
  name: string;
  limit?: number;
}
export interface ResolveSlugOutput {
  candidates: Array<{ basename: string; score: number; label?: string }>;
}

export interface GetVersionsInput {
  slug: string;
}
export interface GetVersionsOutput {
  versions: Array<{
    ts: number;
    isoTs: string;
    writtenBy: string;
    reason: string;
  }>;
}

export interface RevertVersionInput {
  slug: string;
  ts: number;
  writtenBy?: string;
}
export interface RevertVersionOutput {
  revertedToTs: number;
  revertedToIso: string;
  relativePath: string;
}

export interface GetTimelineInput {
  slug: string;
}
export interface GetTimelineOutput {
  /** The raw timeline managed-block body, as written to disk by compile. */
  timelineBlock: string;
}

// =============================================================================
// Handlers — each one a thin wrapper over existing functionality.
// =============================================================================

function resolvePageBySlug(
  vaultPath: string,
  slug: string,
): VaultPageRecord | null {
  const pages = collectVaultPages(vaultPath);
  return (
    pages.find((p) => p.basename === slug || p.frontmatter.id === slug) ?? null
  );
}

const getPage: OperationContract<GetPageInput, GetPageOutput> = {
  name: 'get_page',
  description: 'Read a single page by slug (basename) or page id.',
  handler(vaultPath, input) {
    const page = resolvePageBySlug(vaultPath, input.slug);
    if (!page) throw new Error(`get_page: no page for slug "${input.slug}"`);
    return {
      relativePath: page.relativePath,
      frontmatter: page.frontmatter,
      body: page.body,
    };
  },
};

const putPage: OperationContract<PutPageInput, PutPageOutput> = {
  name: 'put_page',
  description: 'Write a page atomically, snapshotting the prior version.',
  handler(vaultPath, input) {
    const filePath = path.join(vaultPath, input.relativePath);
    writeWikiPage(filePath, input.frontmatter, input.body, {
      writtenBy: input.writtenBy ?? 'operations.put_page',
      reason: input.reason ?? 'put_page call',
    });
    const bytesWritten = fs.statSync(filePath).size;
    return { relativePath: input.relativePath, bytesWritten };
  },
};

const listPages: OperationContract<ListPagesInput, ListPagesOutput> = {
  name: 'list_pages',
  description:
    'Enumerate pages in the vault, optionally filtered by directory or page kind.',
  handler(vaultPath, input) {
    const all = collectVaultPages(vaultPath);
    const filtered = all.filter((p) => {
      if (input.dir && p.dir !== input.dir) return false;
      if (input.kind && p.kind !== input.kind) return false;
      return true;
    });
    return {
      pages: filtered.map((p) => ({
        slug: p.basename,
        relativePath: p.relativePath,
        title: (p.frontmatter.title as string) ?? p.basename,
        kind: p.kind ?? 'unknown',
      })),
    };
  },
};

const search: OperationContract<SearchInput, SearchOutput> = {
  name: 'search',
  description:
    'Substring search over page titles and bodies. Ranks by title-match > body-count. Not a full FTS — the volume-checker flags when to upgrade.',
  handler(vaultPath, input) {
    const limit = input.limit ?? 20;
    const q = input.query.toLowerCase();
    if (!q) return { results: [] };
    const all = collectVaultPages(vaultPath);
    const results: SearchOutput['results'] = [];
    for (const p of all) {
      const title = ((p.frontmatter.title as string) ?? '').toLowerCase();
      const body = p.body.toLowerCase();
      const titleHit = title.includes(q) ? 10 : 0;
      let bodyCount = 0;
      let idx = 0;
      while ((idx = body.indexOf(q, idx)) !== -1) {
        bodyCount++;
        idx += q.length;
        if (bodyCount > 20) break;
      }
      if (titleHit === 0 && bodyCount === 0) continue;
      const score = titleHit + bodyCount;
      const snippetIdx = Math.max(0, body.indexOf(q) - 40);
      const snippet =
        snippetIdx > 0
          ? '…' + p.body.slice(snippetIdx, snippetIdx + 160)
          : p.body.slice(0, 160);
      results.push({
        slug: p.basename,
        relativePath: p.relativePath,
        title: (p.frontmatter.title as string) ?? p.basename,
        snippet,
        score,
      });
    }
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, limit) };
  },
};

const getBacklinks: OperationContract<GetBacklinksInput, GetBacklinksOutput> = {
  name: 'get_backlinks',
  description:
    'Return the basenames of all pages that link to the given slug, sourced from the cached graph index.',
  handler(vaultPath, input) {
    let graph;
    try {
      graph = readGraphIndex(vaultPath);
    } catch {
      // Graph index hasn't been built yet — build it on the fly.
      graph = buildGraph(collectVaultPages(vaultPath));
    }
    return { backlinks: computeBacklinks(graph, input.slug) };
  },
};

const traverseGraph: OperationContract<
  TraverseGraphInput,
  TraverseGraphOutput
> = {
  name: 'traverse_graph',
  description: 'BFS from a starting slug up to the given depth.',
  handler(vaultPath, input) {
    let graph;
    try {
      graph = readGraphIndex(vaultPath);
    } catch {
      graph = buildGraph(collectVaultPages(vaultPath));
    }
    const visited = traverse(graph, input.start, {
      maxDepth: input.maxDepth ?? 2,
    });
    return {
      visited: visited.map((v) => ({ basename: v.basename, depth: v.depth })),
    };
  },
};

const resolveSlugOp: OperationContract<ResolveSlugInput, ResolveSlugOutput> = {
  name: 'resolve_slug',
  description:
    'Trigram fuzzy resolve of a free-form name against all page ids, titles, and basenames. Returns ranked candidates.',
  handler(vaultPath, input) {
    const pages = collectVaultPages(vaultPath).map((p) => ({
      basename: p.basename,
      title:
        typeof p.frontmatter.title === 'string'
          ? p.frontmatter.title
          : undefined,
    }));
    const candidates = resolveSlug(input.name, pages, {
      limit: input.limit ?? 10,
    });
    return { candidates };
  },
};

const getVersions: OperationContract<GetVersionsInput, GetVersionsOutput> = {
  name: 'get_versions',
  description: 'List all prior versions of a page by slug, newest first.',
  handler(vaultPath, input) {
    const versions = listVersions(vaultPath, input.slug);
    return {
      versions: versions.map((v) => ({
        ts: v.ts,
        isoTs: v.isoTs,
        writtenBy: v.writtenBy,
        reason: v.reason ?? '',
      })),
    };
  },
};

const revertVersion: OperationContract<
  RevertVersionInput,
  RevertVersionOutput
> = {
  name: 'revert_version',
  description:
    'Revert a page to a prior version snapshot. A new snapshot of the current state is taken before overwriting.',
  handler(vaultPath, input) {
    const page = resolvePageBySlug(vaultPath, input.slug);
    if (!page) {
      throw new Error(`revert_version: no page for slug "${input.slug}"`);
    }
    const snapshot = readVersion(vaultPath, input.slug, input.ts);
    if (!snapshot) {
      throw new Error(
        `revert_version: version "${input.ts}" not found for "${input.slug}"`,
      );
    }
    const { restored } = revertToVersion({
      vaultPath,
      pagePath: page.filePath,
      slug: input.slug,
      ts: input.ts,
      writtenBy: input.writtenBy ?? 'operations.revert_version',
    });
    return {
      revertedToTs: restored.ts,
      revertedToIso: restored.isoTs,
      relativePath: page.relativePath,
    };
  },
};

const TIMELINE_BLOCK_RE =
  /<!--\s*openclaw:wiki:timeline:start\s*-->([\s\S]*?)<!--\s*openclaw:wiki:timeline:end\s*-->/;

const getTimeline: OperationContract<GetTimelineInput, GetTimelineOutput> = {
  name: 'get_timeline',
  description:
    'Return the auto-generated timeline managed block for a page. Empty string when the page does not qualify for a timeline or compile has not yet run.',
  handler(vaultPath, input) {
    const page = resolvePageBySlug(vaultPath, input.slug);
    if (!page)
      throw new Error(`get_timeline: no page for slug "${input.slug}"`);
    const m = page.body.match(TIMELINE_BLOCK_RE);
    return { timelineBlock: m ? m[1].trim() : '' };
  },
};

// =============================================================================
// Registry
// =============================================================================

export const OPERATIONS: Record<string, OperationContract<unknown, unknown>> = {
  get_page: getPage as unknown as OperationContract<unknown, unknown>,
  put_page: putPage as unknown as OperationContract<unknown, unknown>,
  list_pages: listPages as unknown as OperationContract<unknown, unknown>,
  search: search as unknown as OperationContract<unknown, unknown>,
  get_backlinks: getBacklinks as unknown as OperationContract<unknown, unknown>,
  traverse_graph: traverseGraph as unknown as OperationContract<
    unknown,
    unknown
  >,
  resolve_slug: resolveSlugOp as unknown as OperationContract<unknown, unknown>,
  get_versions: getVersions as unknown as OperationContract<unknown, unknown>,
  revert_version: revertVersion as unknown as OperationContract<
    unknown,
    unknown
  >,
  get_timeline: getTimeline as unknown as OperationContract<unknown, unknown>,
};

export function listOperations(): Array<{ name: string; description: string }> {
  return Object.values(OPERATIONS).map((op) => ({
    name: op.name,
    description: op.description,
  }));
}

export async function invokeOperation<I = unknown, O = unknown>(
  vaultPath: string,
  name: string,
  input: I,
): Promise<O> {
  const op = OPERATIONS[name];
  if (!op) {
    throw new Error(
      `unknown operation "${name}". Known: ${Object.keys(OPERATIONS).join(', ')}`,
    );
  }
  const result = await op.handler(vaultPath, input as unknown);
  return result as O;
}

// Compile-time reference so tsc keeps unused helpers from being pruned;
// also a place to assert serializability when we later add schemas.
void vaultPaths;
void parseWikiPage;
void serializeWikiPage;
void atomicWriteFile;
