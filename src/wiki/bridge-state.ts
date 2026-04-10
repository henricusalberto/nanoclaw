/**
 * Persistent sync state for the wiki bridge. Schema-compatible with
 * OpenClaw's source-sync-state.ts so vaults round-trip cleanly.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { atomicWriteFile, readJsonOrDefault } from './fs-util.js';
import { vaultPaths } from './paths.js';

// "bridge" is the only group NanoClaw produces. The union exists for
// OpenClaw on-disk JSON compat — leave the second variant in place.
export type BridgeGroup = 'bridge' | 'unsafe-local';

export interface SourceSyncEntry {
  group: BridgeGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
}

export interface SourceSyncState {
  version: 1;
  entries: Record<string, SourceSyncEntry>;
  /**
   * Phase 2.5: per-pull-source last-run marker. Keyed by bridge source
   * `id` (not sha1-hashed path), holds the most recent successful sync
   * timestamp so the next run can pass `--after <lastSyncAt>` to the
   * pull command. Optional for backwards compat with vaults written by
   * older NanoClaw.
   */
  pullState?: Record<string, PullSourceState>;
}

export interface PullSourceState {
  lastSyncAt: string;
  lastExtractorVersion?: string;
  lastBookmarkCount?: number;
}

const EMPTY_STATE: SourceSyncState = { version: 1, entries: {} };

export function getSourceSyncStatePath(vaultPath: string): string {
  return vaultPaths(vaultPath).sourceSync;
}

export function resolveArtifactKey(absoluteSourcePath: string): string {
  return crypto.createHash('sha1').update(absoluteSourcePath).digest('hex');
}

export function readSourceSyncState(vaultPath: string): SourceSyncState {
  const parsed = readJsonOrDefault<SourceSyncState>(
    getSourceSyncStatePath(vaultPath),
    EMPTY_STATE,
  );
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof parsed.entries === 'object'
  ) {
    return parsed;
  }
  return { ...EMPTY_STATE, entries: {} };
}

export function writeSourceSyncState(
  vaultPath: string,
  state: SourceSyncState,
): void {
  atomicWriteFile(
    getSourceSyncStatePath(vaultPath),
    JSON.stringify(state, null, 2) + '\n',
  );
}

/**
 * Decide whether a bridge page write can be skipped because nothing has
 * changed. Returns true → skip (cheap path), false → must re-render.
 *
 * Skips when ALL of these match the recorded entry:
 *   - same expected pagePath
 *   - same source absolute path
 *   - same mtimeMs
 *   - same size
 *   - same renderFingerprint
 *   AND the on-disk page file still exists
 *
 * Any mismatch forces a re-render. Source removal is handled separately by
 * pruneImportedSourceEntries.
 */
export function shouldSkipImportedSourceWrite(params: {
  vaultPath: string;
  state: SourceSyncState;
  syncKey: string;
  expectedPagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
}): boolean {
  const entry = params.state.entries[params.syncKey];
  if (!entry) return false;
  if (entry.pagePath !== params.expectedPagePath) return false;
  if (entry.sourcePath !== params.sourcePath) return false;
  if (entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs) return false;
  if (entry.sourceSize !== params.sourceSize) return false;
  if (entry.renderFingerprint !== params.renderFingerprint) return false;
  // Verify the page file still exists on disk — if it was manually deleted,
  // we need to re-render.
  const pagePath = path.join(params.vaultPath, entry.pagePath);
  return fs.existsSync(pagePath);
}

/**
 * Remove sync state entries (and on-disk pages) for sources that no longer
 * exist. Returns count of entries removed.
 *
 * Scoped by group so bridge and unsafe-local don't interfere with each other.
 */
export function pruneImportedSourceEntries(params: {
  vaultPath: string;
  group: BridgeGroup;
  activeKeys: Set<string>;
  state: SourceSyncState;
}): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== params.group) continue;
    if (params.activeKeys.has(key)) continue;
    // Source is gone — remove page and entry
    const pagePath = path.join(params.vaultPath, entry.pagePath);
    if (fs.existsSync(pagePath)) {
      try {
        fs.rmSync(pagePath);
      } catch {
        // ignore — best effort
      }
    }
    delete params.state.entries[key];
    removed++;
  }
  return removed;
}

/**
 * Compute the fingerprint of the bridge page template inputs. When this
 * function's inputs change (e.g., we add a new frontmatter field, change
 * the wrapping markers), every bridged page is re-rendered automatically.
 *
 * Phase 2.5 extension: `extractorName` + `extractorVersion` are mixed in
 * so bumping an extractor's version (e.g., PDF extractor output format
 * changes) forces re-extraction of every page it produced. Omit both
 * for legacy markdown-only sources to preserve the original fingerprint.
 */
export function computeRenderFingerprint(params: {
  artifactKind: string;
  sourceRelativePath: string;
  agentIds: string[];
  templateVersion: number;
  extractorName?: string;
  extractorVersion?: string;
}): string {
  const payload: Record<string, unknown> = {
    artifactKind: params.artifactKind,
    sourceRelativePath: params.sourceRelativePath,
    agentIds: [...params.agentIds].sort(),
    templateVersion: params.templateVersion,
  };
  if (params.extractorName) payload.extractorName = params.extractorName;
  if (params.extractorVersion)
    payload.extractorVersion = params.extractorVersion;
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Read the stored `PullSourceState` for a bridge source, defaulting to
 * epoch zero so the first run fetches everything available. Safe on a
 * fresh vault — `pullState` may be undefined.
 */
export function readPullSourceState(
  state: SourceSyncState,
  sourceId: string,
): PullSourceState {
  return (
    state.pullState?.[sourceId] ?? {
      lastSyncAt: '1970-01-01T00:00:00.000Z',
    }
  );
}

export function writePullSourceState(
  state: SourceSyncState,
  sourceId: string,
  pullState: PullSourceState,
): void {
  if (!state.pullState) state.pullState = {};
  state.pullState[sourceId] = pullState;
}
