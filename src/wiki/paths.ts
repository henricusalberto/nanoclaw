/**
 * Single source of truth for paths inside an OpenClaw-compatible vault.
 * Every other module imports from here so renaming the state dir is one
 * edit, not a grep-and-pray.
 */

import path from 'path';

export const STATE_DIR_NAME = '.openclaw-wiki';
export const CACHE_DIR_NAME = 'cache';

const REL = {
  state: STATE_DIR_NAME,
  cache: path.join(STATE_DIR_NAME, CACHE_DIR_NAME),
  config: path.join(STATE_DIR_NAME, 'config.json'),
  bridgeConfig: path.join(STATE_DIR_NAME, 'bridge.json'),
  sourceSync: path.join(STATE_DIR_NAME, 'source-sync.json'),
  pendingIngest: path.join(STATE_DIR_NAME, 'pending-ingest.json'),
  log: path.join(STATE_DIR_NAME, 'log.jsonl'),
  agentDigest: path.join(STATE_DIR_NAME, CACHE_DIR_NAME, 'agent-digest.json'),
  claimsJsonl: path.join(STATE_DIR_NAME, CACHE_DIR_NAME, 'claims.jsonl'),
} as const;

export function vaultPaths(vaultPath: string): {
  stateDir: string;
  cacheDir: string;
  config: string;
  bridgeConfig: string;
  sourceSync: string;
  pendingIngest: string;
  log: string;
  agentDigest: string;
  claimsJsonl: string;
} {
  return {
    stateDir: path.join(vaultPath, REL.state),
    cacheDir: path.join(vaultPath, REL.cache),
    config: path.join(vaultPath, REL.config),
    bridgeConfig: path.join(vaultPath, REL.bridgeConfig),
    sourceSync: path.join(vaultPath, REL.sourceSync),
    pendingIngest: path.join(vaultPath, REL.pendingIngest),
    log: path.join(vaultPath, REL.log),
    agentDigest: path.join(vaultPath, REL.agentDigest),
    claimsJsonl: path.join(vaultPath, REL.claimsJsonl),
  };
}
