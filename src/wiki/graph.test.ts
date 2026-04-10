import { describe, expect, it } from 'vitest';

import {
  buildGraph,
  computeBacklinks,
  neighbors,
  shortestPath,
  traverse,
} from './graph.js';
import { VaultPageRecord } from './vault-walk.js';

function page(
  basename: string,
  body: string,
  opts: {
    id?: string;
    links?: { type: string; target: string }[];
    kind?: VaultPageRecord['kind'];
  } = {},
): VaultPageRecord {
  return {
    filePath: `/fake/${basename}.md`,
    relativePath: `${basename}.md`,
    basename,
    dir: 'people',
    kind: opts.kind ?? 'person',
    expectedKind: 'person',
    frontmatter: {
      id: opts.id,
      title: basename,
      links: opts.links,
    } as VaultPageRecord['frontmatter'],
    body,
  };
}

describe('graph', () => {
  it('builds nodes for every page and edges for resolved wikilinks', () => {
    const dom = page('dom-ingleston', 'works with [[acme]] and [[ghost]]');
    const acme = page('acme', 'employs [[dom-ingleston]]');
    const graph = buildGraph([dom, acme]);
    expect(Object.keys(graph.nodes).sort()).toEqual(['acme', 'dom-ingleston']);
    // Wikilinks present:
    expect(graph.outEdges['dom-ingleston']).toContainEqual({
      from: 'dom-ingleston',
      to: 'acme',
      type: 'wikilink',
    });
    expect(graph.outEdges['acme']).toContainEqual({
      from: 'acme',
      to: 'dom-ingleston',
      type: 'wikilink',
    });
    // Dangling [[ghost]] is silently dropped.
    expect(graph.outEdges['dom-ingleston'].some((e) => e.to === 'ghost')).toBe(
      false,
    );
  });

  it('reads typed links from frontmatter and resolves by id', () => {
    const dom = page('dom-ingleston', '', {
      id: 'person.dom',
      links: [{ type: 'works-with', target: 'company.acme' }],
    });
    const acme = page('acme', '', { id: 'company.acme' });
    const graph = buildGraph([dom, acme]);
    expect(graph.outEdges['dom-ingleston']).toContainEqual({
      from: 'dom-ingleston',
      to: 'acme',
      type: 'works-with',
    });
  });

  it('drops typed links with unknown target ids', () => {
    const dom = page('dom-ingleston', '', {
      id: 'person.dom',
      links: [{ type: 'cites', target: 'nope.does-not-exist' }],
    });
    const graph = buildGraph([dom]);
    expect(graph.outEdges['dom-ingleston']).toBeUndefined();
  });

  it('neighbors filters by edge type and direction', () => {
    const a = page('a', '[[b]]', {
      id: 'page.a',
      links: [{ type: 'contradicts', target: 'page.c' }],
    });
    const b = page('b', '');
    const c = page('c', '', { id: 'page.c' });
    const graph = buildGraph([a, b, c]);
    expect(neighbors(graph, 'a').sort()).toEqual(['b', 'c']);
    expect(neighbors(graph, 'a', { type: 'wikilink' })).toEqual(['b']);
    expect(neighbors(graph, 'a', { type: 'contradicts' })).toEqual(['c']);
    expect(neighbors(graph, 'b', { direction: 'in' })).toEqual(['a']);
  });

  it('computeBacklinks returns the inverted edges', () => {
    const a = page('a', '[[b]]');
    const b = page('b', '[[c]]');
    const c = page('c', '');
    const graph = buildGraph([a, b, c]);
    expect(computeBacklinks(graph, 'b')).toEqual(['a']);
    expect(computeBacklinks(graph, 'c')).toEqual(['b']);
    expect(computeBacklinks(graph, 'a')).toEqual([]);
  });

  it('traverse does BFS up to maxDepth', () => {
    const a = page('a', '[[b]]');
    const b = page('b', '[[c]]');
    const c = page('c', '[[d]]');
    const d = page('d', '');
    const graph = buildGraph([a, b, c, d]);
    const r = traverse(graph, 'a', { maxDepth: 2 });
    const basenames = r.map((x) => x.basename);
    expect(basenames).toContain('a');
    expect(basenames).toContain('b');
    expect(basenames).toContain('c');
    expect(basenames).not.toContain('d');
  });

  it('shortestPath finds an undirected path', () => {
    const a = page('a', '[[b]]');
    const b = page('b', '[[c]]');
    const c = page('c', '');
    const graph = buildGraph([a, b, c]);
    expect(shortestPath(graph, 'a', 'c')).toEqual(['a', 'b', 'c']);
    // Reverse direction works because shortestPath is undirected.
    expect(shortestPath(graph, 'c', 'a')).toEqual(['c', 'b', 'a']);
  });

  it('shortestPath returns null for disconnected nodes', () => {
    const a = page('a', '');
    const b = page('b', '');
    const graph = buildGraph([a, b]);
    expect(shortestPath(graph, 'a', 'b')).toBeNull();
  });
});
