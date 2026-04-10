/**
 * In-memory graph index built from body wikilinks + typed frontmatter
 * links. Built once per compile pass and cached at
 * `.openclaw-wiki/graph-index.json` so CLI traversal commands don't
 * pay the rebuild cost on every invocation.
 *
 * Edges are directed: an edge from A to B does NOT imply an edge from
 * B to A. Backlinks are computed by inverting the adjacency on demand.
 *
 * Node identity is the lowercased basename (e.g. `dom-ingleston`),
 * which matches how wikilinks resolve elsewhere in the codebase. Pages
 * with frontmatter `id` are also indexed by id so typed links (which
 * use ids) resolve to the right basename.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import { LinkType, readTypedLinks } from './links.js';
import { extractWikiLinks } from './markdown.js';
import { vaultPaths } from './paths.js';
import { VaultPageRecord } from './vault-walk.js';

export interface GraphEdge {
  from: string;
  to: string;
  /** 'wikilink' for body [[bracket]] refs, otherwise the typed-link type. */
  type: 'wikilink' | LinkType;
}

export interface GraphNode {
  basename: string;
  id?: string;
  title?: string;
  kind?: string;
}

export interface WikiGraph {
  nodes: Record<string, GraphNode>;
  /** Outgoing edges keyed by source basename. */
  outEdges: Record<string, GraphEdge[]>;
  /** Incoming edges keyed by target basename. */
  inEdges: Record<string, GraphEdge[]>;
  /** ISO timestamp of last build. */
  builtAt: string;
  /** Number of pages walked. */
  pageCount: number;
}

const EMPTY_GRAPH: WikiGraph = {
  nodes: {},
  outEdges: {},
  inEdges: {},
  builtAt: '1970-01-01T00:00:00.000Z',
  pageCount: 0,
};

function getGraphIndexPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'graph-index.json');
}

/**
 * Build the graph from a snapshot of vault pages. Pure: no I/O beyond
 * the final cache write. Caller passes the same `pages` array used by
 * compile so we don't re-walk.
 */
export function buildGraph(pages: VaultPageRecord[]): WikiGraph {
  const nodes: Record<string, GraphNode> = {};
  const outEdges: Record<string, GraphEdge[]> = {};
  const inEdges: Record<string, GraphEdge[]> = {};
  const idToBasename = new Map<string, string>();

  // First pass: register every page as a node so unresolved targets
  // (like a wikilink to a page that doesn't exist yet) don't appear
  // in the graph.
  for (const page of pages) {
    const node: GraphNode = {
      basename: page.basename,
      kind: page.kind,
    };
    if (typeof page.frontmatter.id === 'string') {
      node.id = page.frontmatter.id;
      idToBasename.set(page.frontmatter.id, page.basename);
    }
    if (typeof page.frontmatter.title === 'string') {
      node.title = page.frontmatter.title;
    }
    nodes[page.basename] = node;
  }

  // Second pass: walk links.
  for (const page of pages) {
    const fromBasename = page.basename;
    const out: GraphEdge[] = [];

    // Body wikilinks
    for (const link of extractWikiLinks(page.body)) {
      const toBasename = link.toLowerCase();
      if (!nodes[toBasename]) continue; // dangling — not a graph edge
      if (toBasename === fromBasename) continue; // self-loop
      out.push({ from: fromBasename, to: toBasename, type: 'wikilink' });
    }

    // Typed links from frontmatter
    for (const typed of readTypedLinks(page.frontmatter)) {
      const toBasename = idToBasename.get(typed.target);
      if (!toBasename) continue;
      if (toBasename === fromBasename) continue;
      out.push({ from: fromBasename, to: toBasename, type: typed.type });
    }

    if (out.length > 0) outEdges[fromBasename] = out;
  }

  // Build inverted adjacency in one pass.
  for (const edges of Object.values(outEdges)) {
    for (const edge of edges) {
      const arr = inEdges[edge.to] ?? [];
      arr.push(edge);
      inEdges[edge.to] = arr;
    }
  }

  return {
    nodes,
    outEdges,
    inEdges,
    builtAt: new Date().toISOString(),
    pageCount: pages.length,
  };
}

export function writeGraphIndex(vaultPath: string, graph: WikiGraph): void {
  fs.mkdirSync(path.dirname(getGraphIndexPath(vaultPath)), {
    recursive: true,
  });
  atomicWriteFile(
    getGraphIndexPath(vaultPath),
    JSON.stringify(graph, null, 2) + '\n',
  );
}

/**
 * Diff-gated writer used by the compile hot path. Skips the disk write
 * (and the bridge churn it would cause) when the graph's structural
 * content matches the on-disk cache. Compares everything except
 * `builtAt`, since the timestamp would defeat the diff every time.
 */
export function writeGraphIndexIfChanged(
  vaultPath: string,
  graph: WikiGraph,
): boolean {
  const existing = readGraphIndex(vaultPath);
  const same =
    existing.pageCount === graph.pageCount &&
    JSON.stringify(existing.nodes) === JSON.stringify(graph.nodes) &&
    JSON.stringify(existing.outEdges) === JSON.stringify(graph.outEdges);
  if (same) return false;
  writeGraphIndex(vaultPath, graph);
  return true;
}

export function readGraphIndex(vaultPath: string): WikiGraph {
  return readJsonOrDefault<WikiGraph>(
    getGraphIndexPath(vaultPath),
    EMPTY_GRAPH,
  );
}

// =============================================================================
// Traversal API
// =============================================================================

export interface NeighborQuery {
  /** Filter by edge type. Omit for all edges. */
  type?: GraphEdge['type'];
  /** 'out' = follow outgoing edges, 'in' = backlinks, 'both' = union. */
  direction?: 'out' | 'in' | 'both';
}

export function neighbors(
  graph: WikiGraph,
  basename: string,
  query: NeighborQuery = {},
): string[] {
  const direction = query.direction ?? 'out';
  const out: string[] = [];
  const seen = new Set<string>();
  const collect = (edges: GraphEdge[] | undefined, key: 'from' | 'to') => {
    if (!edges) return;
    for (const e of edges) {
      if (query.type && e.type !== query.type) continue;
      const target = e[key];
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  };
  if (direction === 'out' || direction === 'both') {
    collect(graph.outEdges[basename], 'to');
  }
  if (direction === 'in' || direction === 'both') {
    collect(graph.inEdges[basename], 'from');
  }
  return out;
}

export function computeBacklinks(graph: WikiGraph, basename: string): string[] {
  return neighbors(graph, basename, { direction: 'in' });
}

export interface TraverseOptions {
  maxDepth?: number;
  type?: GraphEdge['type'];
  direction?: 'out' | 'in' | 'both';
}

export interface TraverseResult {
  basename: string;
  depth: number;
}

/**
 * Breadth-first traversal from `start`. Returns nodes in BFS order
 * with their depth. Depth 0 is `start` itself.
 */
export function traverse(
  graph: WikiGraph,
  start: string,
  opts: TraverseOptions = {},
): TraverseResult[] {
  if (!graph.nodes[start]) return [];
  const maxDepth = opts.maxDepth ?? 3;
  const seen = new Set<string>([start]);
  const queue: TraverseResult[] = [{ basename: start, depth: 0 }];
  const out: TraverseResult[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    out.push(node);
    if (node.depth >= maxDepth) continue;
    const next = neighbors(graph, node.basename, {
      type: opts.type,
      direction: opts.direction,
    });
    for (const n of next) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ basename: n, depth: node.depth + 1 });
    }
  }
  return out;
}

/**
 * Shortest unweighted path between two nodes — undirected (treats
 * edges as bidirectional). Returns the basename sequence including
 * both endpoints, or null if disconnected.
 */
export function shortestPath(
  graph: WikiGraph,
  a: string,
  b: string,
): string[] | null {
  if (!graph.nodes[a] || !graph.nodes[b]) return null;
  if (a === b) return [a];
  const prev = new Map<string, string>();
  const visited = new Set<string>([a]);
  const queue: string[] = [a];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === b) break;
    const next = neighbors(graph, node, { direction: 'both' });
    for (const n of next) {
      if (visited.has(n)) continue;
      visited.add(n);
      prev.set(n, node);
      if (n === b) {
        queue.length = 0; // break outer
        break;
      }
      queue.push(n);
    }
  }
  if (!prev.has(b) && a !== b) return null;
  const path: string[] = [b];
  let cursor = b;
  while (cursor !== a) {
    const p = prev.get(cursor);
    if (!p) return null;
    path.push(p);
    cursor = p;
  }
  return path.reverse();
}
