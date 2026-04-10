/**
 * Per-page version history.
 *
 * Every call to `writeWikiPage()` snapshots the page's PRIOR state to
 * `.openclaw-wiki/versions/<slug>/<unix-ms>.json` so the wiki becomes
 * answerable across time. Snapshots are read-only forever.
 *
 * Pruning policy: keep the most recent 50 snapshots per page. Older
 * versions are dropped on the next write — daily-keyed retention
 * (which the plan describes for very-long-lived pages) is a
 * follow-up if storage grows past the ~8 MiB ceiling.
 *
 * The audit trail lives entirely under `.openclaw-wiki/`, never inside
 * the markdown vault, so it doesn't pollute Obsidian or fight the
 * bridge.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import {
  parseWikiPage,
  serializeWikiPage,
  WikiPageFrontmatter,
} from './markdown.js';
import { vaultPaths } from './paths.js';

const KEEP_VERSIONS_PER_PAGE = 50;

export interface VersionRecord {
  /** Unix milliseconds at snapshot time. Also the filename stem. */
  ts: number;
  /** ISO-8601 form of `ts` for human-readable diffs. */
  isoTs: string;
  /** Page id at snapshot time. */
  pageId: string;
  /** Frontmatter as it existed before the write. */
  frontmatter: WikiPageFrontmatter;
  /** Body as it existed before the write. */
  body: string;
  /** Free-form actor: 'janus' | 'autofix' | 'migrate-vault' | 'manual' | etc. */
  writtenBy: string;
  /** Free-form short reason. Optional but recommended. */
  reason?: string;
}

export interface SnapshotInput {
  vaultPath: string;
  pagePath: string;
  writtenBy: string;
  reason?: string;
}

/**
 * Snapshot the current on-disk state of a page BEFORE a write replaces
 * it. Safe to call when the page doesn't exist yet — first writes
 * have nothing to snapshot, so we no-op.
 *
 * Returns the created snapshot's path, or null when there was nothing
 * to snapshot.
 */
export function snapshotBeforeWrite(input: SnapshotInput): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(input.pagePath, 'utf-8');
  } catch {
    // Page didn't exist (first write) or unreadable — nothing to snapshot.
    return null;
  }
  let parsed;
  try {
    parsed = parseWikiPage(raw);
  } catch {
    // Malformed frontmatter — don't snapshot, but don't fail the write.
    return null;
  }
  const slug = pageSlugFromPath(input.pagePath);
  const dir = versionsDir(input.vaultPath, slug);
  fs.mkdirSync(dir, { recursive: true });
  const ts = Date.now();
  const record: VersionRecord = {
    ts,
    isoTs: new Date(ts).toISOString(),
    pageId:
      typeof parsed.frontmatter.id === 'string' ? parsed.frontmatter.id : slug,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    writtenBy: input.writtenBy,
    reason: input.reason,
  };
  const target = path.join(dir, `${ts}.json`);
  atomicWriteFile(target, JSON.stringify(record, null, 2) + '\n');
  pruneOldVersions(dir);
  return target;
}

/**
 * List versions for a page, newest first. Pages with no history return
 * an empty array.
 */
export function listVersions(vaultPath: string, slug: string): VersionRecord[] {
  const dir = versionsDir(vaultPath, slug);
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = dirEntries
    .filter((f) => f.endsWith('.json'))
    .sort((a, b) => parseInt(b) - parseInt(a));
  const out: VersionRecord[] = [];
  for (const f of files) {
    try {
      const json = JSON.parse(
        fs.readFileSync(path.join(dir, f), 'utf-8'),
      ) as VersionRecord;
      out.push(json);
    } catch {
      // skip corrupted snapshot
    }
  }
  return out;
}

/**
 * Read a single version by timestamp. Returns null when not found.
 */
export function readVersion(
  vaultPath: string,
  slug: string,
  ts: number,
): VersionRecord | null {
  const file = path.join(versionsDir(vaultPath, slug), `${ts}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as VersionRecord;
  } catch {
    return null;
  }
}

/**
 * Compute a unified-style line diff between two versions of a page.
 * Pure JS — no `diff` dependency. Output is human-readable; not a
 * patch suitable for `patch -p1`.
 */
export function diffVersions(a: VersionRecord, b: VersionRecord): string {
  const aLines = serializeWikiPage(a.frontmatter, a.body).split('\n');
  const bLines = serializeWikiPage(b.frontmatter, b.body).split('\n');
  return simpleLineDiff(aLines, bLines);
}

/**
 * Restore a page to a prior version. Snapshots the CURRENT state first
 * so the revert itself is reversible. Returns the new (post-revert)
 * snapshot path so the caller can show what was undone.
 */
export function revertToVersion(params: {
  vaultPath: string;
  pagePath: string;
  slug: string;
  ts: number;
  writtenBy: string;
}): { restored: VersionRecord; preRevertSnapshot: string | null } {
  const target = readVersion(params.vaultPath, params.slug, params.ts);
  if (!target) {
    throw new Error(
      `no version ${params.ts} for ${params.slug} — list versions first`,
    );
  }
  const preRevertSnapshot = snapshotBeforeWrite({
    vaultPath: params.vaultPath,
    pagePath: params.pagePath,
    writtenBy: params.writtenBy,
    reason: `pre-revert to ${target.isoTs}`,
  });
  const newContent = serializeWikiPage(target.frontmatter, target.body);
  fs.mkdirSync(path.dirname(params.pagePath), { recursive: true });
  atomicWriteFile(params.pagePath, newContent);
  return { restored: target, preRevertSnapshot };
}

/**
 * Resolve a page's audit slug from its on-disk basename. We key on
 * basename rather than frontmatter `id` because basename is stable
 * across Phase 3 migrations (which only change directories), is
 * filesystem-safe without escaping, and doesn't collide when two
 * mid-migration pages temporarily share an `id`.
 */
function pageSlugFromPath(pagePath: string): string {
  return path.basename(pagePath, '.md').toLowerCase();
}

// =============================================================================
// Internals
// =============================================================================

function versionsDir(vaultPath: string, slug: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'versions', slug);
}

function pruneOldVersions(dir: string): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  // Cheap path: nothing to prune. Skip the sort entirely.
  if (files.length <= KEEP_VERSIONS_PER_PAGE) return;
  files.sort((a, b) => parseInt(b) - parseInt(a));
  for (const f of files.slice(KEEP_VERSIONS_PER_PAGE)) {
    try {
      fs.rmSync(path.join(dir, f));
    } catch {
      // best effort
    }
  }
}

/**
 * Tiny line diff — labels each line as `+`, `-`, or ` `. Not LCS;
 * uses a forward two-pointer scan that works well when most lines
 * are unchanged (the common case for wiki edits).
 */
function simpleLineDiff(a: string[], b: string[]): string {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
      continue;
    }
    // Look ahead a few lines for a re-sync point.
    const SCAN = 20;
    let resyncA = -1;
    let resyncB = -1;
    for (let k = 1; k <= SCAN; k++) {
      if (i + k < a.length && j < b.length && a[i + k] === b[j]) {
        resyncA = i + k;
        resyncB = j;
        break;
      }
      if (j + k < b.length && i < a.length && a[i] === b[j + k]) {
        resyncA = i;
        resyncB = j + k;
        break;
      }
    }
    if (resyncA >= 0 && resyncB >= 0) {
      while (i < resyncA) {
        out.push(`- ${a[i++]}`);
      }
      while (j < resyncB) {
        out.push(`+ ${b[j++]}`);
      }
      continue;
    }
    if (i < a.length) out.push(`- ${a[i++]}`);
    if (j < b.length) out.push(`+ ${b[j++]}`);
  }
  return out.join('\n');
}
