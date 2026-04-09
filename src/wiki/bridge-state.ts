/**
 * Persistent sync state for the wiki bridge.
 *
 * Path: <vaultPath>/.openclaw-wiki/source-sync.json
 *
 * Direct port of OpenClaw's `extensions/memory-wiki/src/source-sync-state.ts`.
 * The schema is identical so vaults round-trip cleanly between the two tools.
 *
 * Each entry tracks one bridged source file:
 *   syncKey            = sha1(absolute source path) — stable id
 *   group              = "bridge" | "unsafe-local" — partition (we use bridge)
 *   pagePath           = relative path inside the vault to the bridge page
 *   sourcePath         = absolute path to the original source file
 *   sourceUpdatedAtMs  = mtime in ms (cheap freshness check)
 *   sourceSize         = byte size (cheap freshness check)
 *   renderFingerprint  = sha1 of the template inputs — when the rendering
 *                        template changes, this fingerprint changes and
 *                        every page is re-rendered
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
}

const STATE_RELATIVE_PATH = '.openclaw-wiki/source-sync.json';

export function getSourceSyncStatePath(vaultPath: string): string {
  return path.join(vaultPath, STATE_RELATIVE_PATH);
}

export function resolveArtifactKey(absoluteSourcePath: string): string {
  return crypto.createHash('sha1').update(absoluteSourcePath).digest('hex');
}

export function readSourceSyncState(vaultPath: string): SourceSyncState {
  const p = getSourceSyncStatePath(vaultPath);
  if (!fs.existsSync(p)) {
    return { version: 1, entries: {} };
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.entries === 'object'
    ) {
      return parsed as SourceSyncState;
    }
  } catch {
    // Corrupt state — treat as empty, self-healing on next write.
  }
  return { version: 1, entries: {} };
}

export function writeSourceSyncState(
  vaultPath: string,
  state: SourceSyncState,
): void {
  const p = getSourceSyncStatePath(vaultPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write via temp+rename
  const temp = `${p}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(temp, p);
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
 */
export function computeRenderFingerprint(params: {
  artifactKind: string;
  sourceRelativePath: string;
  agentIds: string[];
  templateVersion: number;
}): string {
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        artifactKind: params.artifactKind,
        sourceRelativePath: params.sourceRelativePath,
        agentIds: [...params.agentIds].sort(),
        templateVersion: params.templateVersion,
      }),
    )
    .digest('hex');
}
