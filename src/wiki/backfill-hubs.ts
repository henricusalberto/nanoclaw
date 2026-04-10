/**
 * Walk every non-hub page in the vault, run the hub rule table, and
 * write `hub: <slug>` to frontmatter. Idempotent — pages already
 * carrying an explicit `hub:` keep theirs. Runs host-side only; no
 * LLM calls.
 */

import { writeWikiPage } from './markdown.js';
import { resolveHub } from './hub-rules.js';
import { collectVaultPages } from './vault-walk.js';

export interface BackfillHubsResult {
  scanned: number;
  alreadyAssigned: number;
  newlyAssigned: number;
  skipped: number;
  byHub: Record<string, number>;
  pagesWritten: number;
}

export interface BackfillHubsOptions {
  apply: boolean;
  /**
   * When true, overwrite existing hub tags on non-source pages. Used
   * when the rule table has changed and older runs are stale. Source
   * pages (bookmarks) are never overwritten — they carry the bookmark
   * classifier's decision, which this rule engine isn't allowed to
   * touch.
   */
  force?: boolean;
}

export function runBackfillHubs(
  vaultPath: string,
  opts: BackfillHubsOptions,
): BackfillHubsResult {
  const pages = collectVaultPages(vaultPath);
  const result: BackfillHubsResult = {
    scanned: 0,
    alreadyAssigned: 0,
    newlyAssigned: 0,
    skipped: 0,
    byHub: {},
    pagesWritten: 0,
  };

  for (const page of pages) {
    result.scanned++;

    // Don't touch hub pages themselves — their hub frontmatter points
    // at their own slug and the projection uses that as the group key.
    if (page.kind === 'hub') {
      result.skipped++;
      continue;
    }

    // Source pages carry the bookmark classifier's decision — never
    // overwrite them from the rule engine.
    const existing = page.frontmatter.hub;
    const isSource = page.kind === 'source' || page.expectedKind === 'source';
    if (typeof existing === 'string' && existing.trim().length > 0) {
      if (!opts.force || isSource) {
        result.alreadyAssigned++;
        result.byHub[existing.trim()] =
          (result.byHub[existing.trim()] ?? 0) + 1;
        continue;
      }
      // Force-overwrite path: fall through and re-resolve.
    }

    const hub = resolveHub(
      {
        basename: page.basename,
        kind: page.kind,
        expectedKind: page.expectedKind,
        frontmatter: page.frontmatter,
      },
      { ignoreExisting: opts.force === true },
    );

    if (!hub) {
      // Force mode on a previously-tagged page that no longer resolves
      // to any hub: clear the tag so it falls out of hub projections.
      if (opts.force && typeof existing === 'string') {
        if (opts.apply) {
          const next = { ...page.frontmatter };
          delete next.hub;
          writeWikiPage(page.filePath, next, page.body, {
            writtenBy: 'backfill-hubs',
            reason: 'clear stale hub tag',
          });
          result.pagesWritten++;
        }
      }
      result.skipped++;
      continue;
    }

    result.newlyAssigned++;
    result.byHub[hub] = (result.byHub[hub] ?? 0) + 1;

    if (opts.apply) {
      const next = { ...page.frontmatter, hub };
      writeWikiPage(page.filePath, next, page.body, {
        writtenBy: 'backfill-hubs',
        reason: `assign hub: ${hub}`,
      });
      result.pagesWritten++;
    }
  }

  return result;
}
