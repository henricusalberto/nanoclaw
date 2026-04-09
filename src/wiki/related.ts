/**
 * Auto-related block computation. Pure set operations on parsed page metadata.
 *
 * Ports OpenClaw's `extensions/memory-wiki/src/compile.ts:397-504`
 * (`buildRelatedBlockBody`, `refreshPageRelatedBlocks`).
 *
 * Three buckets per page (disjoint):
 *   1. **Sources**       — pages whose `id` appears in this page's `sourceIds`
 *   2. **Referenced By** — pages that list this page in their `sourceIds`,
 *                           OR have a wikilink targeting this page
 *   3. **Related Pages** — pages that share at least one `sourceId` with this
 *                           page (and aren't already in #1 or #2)
 *
 * Output is a managed-block markdown section that the compile step writes
 * to each page.
 */

import path from 'path';
import {
  extractWikiLinks,
  normalizeLinkTarget,
  ParsedWikiPage,
  WikiPageFrontmatter,
  WikiPageKind,
} from './markdown.js';

export interface PageSummary {
  id: string;
  title: string;
  kind: WikiPageKind;
  filePath: string; // absolute
  relativePath: string; // relative to vault
  basename: string; // filename without .md
  sourceIds: string[];
  linkTargets: string[]; // normalized basenames extracted from body
}

export function summarizePage(
  filePath: string,
  vaultRoot: string,
  parsed: ParsedWikiPage,
): PageSummary | null {
  const fm = parsed.frontmatter as WikiPageFrontmatter;
  const id = fm.id;
  if (!id) return null;
  const kind = fm.pageType;
  if (!kind) return null;
  const basename = path.basename(filePath, '.md').toLowerCase();
  return {
    id,
    title: fm.title || basename,
    kind,
    filePath,
    relativePath: path.relative(vaultRoot, filePath),
    basename,
    sourceIds: Array.isArray(fm.sourceIds) ? fm.sourceIds : [],
    linkTargets: extractWikiLinks(parsed.body),
  };
}

interface RelatedBuckets {
  sources: PageSummary[];
  referencedBy: PageSummary[];
  related: PageSummary[];
}

export function computeRelatedBuckets(
  page: PageSummary,
  allPages: PageSummary[],
  pagesById: Map<string, PageSummary>,
  pagesByBasename: Map<string, PageSummary>,
): RelatedBuckets {
  // 1. Sources — pages this one explicitly cites by id
  const sourcePages: PageSummary[] = [];
  for (const sourceId of page.sourceIds) {
    const target = pagesById.get(sourceId);
    if (target && target.id !== page.id) {
      sourcePages.push(target);
    }
  }
  const sourcePageIds = new Set(sourcePages.map((p) => p.id));

  // 2. Referenced By — reverse of sourceIds + wikilink lookups
  const referencedByPages: PageSummary[] = [];
  for (const candidate of allPages) {
    if (candidate.id === page.id) continue;
    if (sourcePageIds.has(candidate.id)) continue;
    let isReferencer = false;
    if (candidate.sourceIds.includes(page.id)) {
      isReferencer = true;
    } else if (candidate.linkTargets.includes(page.basename)) {
      isReferencer = true;
    }
    if (isReferencer) {
      referencedByPages.push(candidate);
    }
  }
  const referencedByIds = new Set(referencedByPages.map((p) => p.id));

  // 3. Related Pages — shared-source co-occurrence
  const relatedPages: PageSummary[] = [];
  if (page.sourceIds.length > 0) {
    for (const candidate of allPages) {
      if (candidate.id === page.id) continue;
      if (sourcePageIds.has(candidate.id)) continue;
      if (referencedByIds.has(candidate.id)) continue;
      if (candidate.sourceIds.length === 0) continue;
      const hasSharedSource = candidate.sourceIds.some((s) =>
        page.sourceIds.includes(s),
      );
      if (hasSharedSource) {
        relatedPages.push(candidate);
      }
    }
  }

  // Sort each bucket by title for stable output
  const sortByTitle = (a: PageSummary, b: PageSummary) =>
    a.title.localeCompare(b.title);
  sourcePages.sort(sortByTitle);
  referencedByPages.sort(sortByTitle);
  relatedPages.sort(sortByTitle);

  // Cap each bucket at 20 to avoid wall-of-links pages
  return {
    sources: sourcePages.slice(0, 20),
    referencedBy: referencedByPages.slice(0, 20),
    related: relatedPages.slice(0, 20),
  };
}

export function renderRelatedBlock(buckets: RelatedBuckets): string {
  const lines: string[] = ['## Related', ''];

  if (buckets.sources.length > 0) {
    lines.push('### Sources');
    for (const p of buckets.sources) {
      lines.push(`- [[${p.basename}|${p.title}]]`);
    }
    lines.push('');
  }

  if (buckets.referencedBy.length > 0) {
    lines.push('### Referenced By');
    for (const p of buckets.referencedBy) {
      lines.push(`- [[${p.basename}|${p.title}]]`);
    }
    lines.push('');
  }

  if (buckets.related.length > 0) {
    lines.push('### Related Pages');
    for (const p of buckets.related) {
      lines.push(`- [[${p.basename}|${p.title}]]`);
    }
    lines.push('');
  }

  if (
    buckets.sources.length === 0 &&
    buckets.referencedBy.length === 0 &&
    buckets.related.length === 0
  ) {
    lines.push('*(no cross-references yet)*');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
