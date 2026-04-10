/**
 * Wire up cross-module hooks that would otherwise create import cycles.
 *
 * Currently this only installs the version-snapshot hook into
 * `markdown.ts::writeWikiPage`. Import this module from any entry
 * point that performs writes (CLI, host runtime, dream cycle).
 */

import { setWriteWikiPageHook } from './markdown.js';
import { snapshotBeforeWrite } from './versions.js';

let installed = false;

export interface InstallOptions {
  /** Vault root path. Required so the snapshotter knows where to write. */
  vaultPath: string;
}

export function installWikiHooks(opts: InstallOptions): void {
  if (installed) return;
  installed = true;
  setWriteWikiPageHook((params) => {
    snapshotBeforeWrite({
      vaultPath: opts.vaultPath,
      pagePath: params.filePath,
      writtenBy: params.writtenBy ?? 'unknown',
      reason: params.reason,
    });
  });
}

/** Test helper — un-install hooks so vitest runs each suite cleanly. */
export function uninstallWikiHooks(): void {
  setWriteWikiPageHook(null);
  installed = false;
}
