/**
 * Bridge config (`.openclaw-wiki/bridge.json`). User-editable.
 */

import fs from 'fs';

import { atomicWriteFile } from './fs-util.js';
import { vaultPaths } from './paths.js';

export type BridgeArtifactKind =
  | 'memory-root'
  | 'daily-note'
  | 'dream-report'
  | 'event-log'
  | 'user-context';

export interface BridgeSourceConfig {
  id: string;
  kind: BridgeArtifactKind;
  /**
   * Root path relative to the repo root. The glob is matched against
   * files under this root.
   */
  rootPath: string;
  glob: string; // e.g. "*.md", "**/*.md", "memory/*.md"
  exclude?: string[]; // glob patterns to exclude
  agentIds?: string[];
  maxFileSizeBytes?: number; // skip if larger
}

export interface EntityScanConfig {
  /** Master on/off switch. Defaults to false — opt-in per-vault. */
  enabled: boolean;
  /** Hard daily spend cap in USD. Above this, LLM calls are suppressed. */
  dailyBudgetUsd: number;
  /** Idle window after last message before a conversation closes, seconds. */
  windowIdleSeconds: number;
  /** Max messages before a window is force-flushed regardless of idle. */
  windowMaxMessages: number;
  /** IANA tz for quiet-hours computation. */
  quietHoursTz: string;
  /** Quiet window start hour, local time, inclusive. */
  quietHoursStart: number;
  /** Quiet window end hour, local time, exclusive. */
  quietHoursEnd: number;
}

export interface BridgeConfig {
  vaultMode: 'bridge';
  ingest: {
    autoCompile: boolean;
    autoIngest: boolean;
  };
  sources: BridgeSourceConfig[];
  /** Concept-tag stopwords merged with the built-in defaults. */
  conceptTagStopwords?: string[];
  /** Phase 2: conversation-window entity detection. Off by default. */
  entityScan?: EntityScanConfig;
}

export const DEFAULT_ENTITY_SCAN_CONFIG: EntityScanConfig = {
  enabled: false,
  dailyBudgetUsd: 1.5,
  windowIdleSeconds: 60,
  windowMaxMessages: 10,
  quietHoursTz: 'Europe/Berlin',
  quietHoursStart: 23,
  quietHoursEnd: 7,
};

export function getBridgeConfigPath(vaultPath: string): string {
  return vaultPaths(vaultPath).bridgeConfig;
}

/**
 * Default bridge config. Written to disk on first run if no config exists.
 *
 * Sources cover NanoClaw's actual memory paths (post-OpenClaw memory port):
 *   - global memory directory (active and archive)
 *   - global MEMORY.md (cron-managed long-term store)
 *   - global user-context.md (stable identity file)
 *   - per-group memory and notes (any other group that builds memory)
 *   - per-group top-level docs (excluding CLAUDE.md and our own wiki dir)
 */
export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  vaultMode: 'bridge',
  ingest: {
    autoCompile: true,
    autoIngest: true,
  },
  sources: [
    {
      id: 'global-memory-active',
      kind: 'daily-note',
      rootPath: 'groups/global/memory',
      glob: '*.md',
      exclude: ['README.md'],
      agentIds: ['janus-nano'],
      maxFileSizeBytes: 500_000,
    },
    {
      id: 'global-memory-archive',
      kind: 'daily-note',
      rootPath: 'groups/global/memory/archive',
      glob: '*.md',
      agentIds: ['janus-nano'],
      maxFileSizeBytes: 500_000,
    },
    {
      id: 'global-memory-root',
      kind: 'memory-root',
      rootPath: 'groups/global',
      glob: 'MEMORY.md',
      agentIds: ['janus-nano'],
    },
    {
      id: 'global-user-context',
      kind: 'user-context',
      rootPath: 'groups/global',
      glob: 'user-context.md',
      agentIds: ['janus-nano'],
    },
    {
      id: 'all-groups-memory',
      kind: 'daily-note',
      rootPath: 'groups',
      glob: '*/memory/**/*.md',
      exclude: ['telegram_wiki-inbox/**', 'global/**'],
      agentIds: ['janus-nano'],
      maxFileSizeBytes: 500_000,
    },
    {
      id: 'all-groups-notes',
      kind: 'daily-note',
      rootPath: 'groups',
      glob: '*/notes/**/*.md',
      exclude: ['telegram_wiki-inbox/**', 'global/**'],
      agentIds: ['janus-nano'],
      maxFileSizeBytes: 500_000,
    },
  ],
};

// Cache parsed config keyed by mtime so per-spawn calls don't re-parse
// the JSON unless the file actually changed. Stat is O(1) and much
// cheaper than fs.readFileSync + JSON.parse on every container spawn.
const cache = new Map<string, { mtimeMs: number; config: BridgeConfig }>();

export function readBridgeConfig(vaultPath: string): BridgeConfig {
  const p = getBridgeConfigPath(vaultPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(p);
  } catch {
    return DEFAULT_BRIDGE_CONFIG;
  }
  const cached = cache.get(p);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.config;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return DEFAULT_BRIDGE_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Loud, not silent: a malformed user config should not silently revert
    // to defaults — that masks the user's edits.
    console.warn(
      `[wiki] bridge.json is not valid JSON (${(err as Error).message}); falling back to defaults`,
    );
    return DEFAULT_BRIDGE_CONFIG;
  }
  const config = coerceBridgeConfig(parsed);
  cache.set(p, { mtimeMs: stat.mtimeMs, config });
  return config;
}

export function writeBridgeConfig(
  vaultPath: string,
  config: BridgeConfig,
): void {
  atomicWriteFile(
    getBridgeConfigPath(vaultPath),
    JSON.stringify(config, null, 2) + '\n',
  );
  cache.delete(getBridgeConfigPath(vaultPath));
}

export function ensureBridgeConfig(vaultPath: string): BridgeConfig {
  const p = getBridgeConfigPath(vaultPath);
  if (!fs.existsSync(p)) {
    writeBridgeConfig(vaultPath, DEFAULT_BRIDGE_CONFIG);
    return DEFAULT_BRIDGE_CONFIG;
  }
  return readBridgeConfig(vaultPath);
}

// Coerce, not validate. Any field that doesn't match the expected shape
// falls back to its default. Source-level validation is done lazily by
// the bridge — invalid sources just produce zero matches.
function coerceBridgeConfig(parsed: unknown): BridgeConfig {
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_BRIDGE_CONFIG;
  }
  const obj = parsed as Record<string, unknown>;
  const sources = Array.isArray(obj.sources)
    ? (obj.sources as BridgeSourceConfig[])
    : DEFAULT_BRIDGE_CONFIG.sources;
  const ingest =
    typeof obj.ingest === 'object' && obj.ingest !== null
      ? (obj.ingest as { autoCompile: boolean; autoIngest: boolean })
      : DEFAULT_BRIDGE_CONFIG.ingest;
  const conceptTagStopwords = Array.isArray(obj.conceptTagStopwords)
    ? (obj.conceptTagStopwords as string[])
    : undefined;
  const entityScan = coerceEntityScanConfig(obj.entityScan);
  return {
    vaultMode: 'bridge',
    ingest: {
      autoCompile: ingest.autoCompile ?? true,
      autoIngest: ingest.autoIngest ?? true,
    },
    sources,
    ...(conceptTagStopwords && { conceptTagStopwords }),
    ...(entityScan && { entityScan }),
  };
}

function coerceEntityScanConfig(parsed: unknown): EntityScanConfig | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  return {
    enabled:
      typeof obj.enabled === 'boolean'
        ? obj.enabled
        : DEFAULT_ENTITY_SCAN_CONFIG.enabled,
    dailyBudgetUsd:
      typeof obj.dailyBudgetUsd === 'number'
        ? obj.dailyBudgetUsd
        : DEFAULT_ENTITY_SCAN_CONFIG.dailyBudgetUsd,
    windowIdleSeconds:
      typeof obj.windowIdleSeconds === 'number'
        ? obj.windowIdleSeconds
        : DEFAULT_ENTITY_SCAN_CONFIG.windowIdleSeconds,
    windowMaxMessages:
      typeof obj.windowMaxMessages === 'number'
        ? obj.windowMaxMessages
        : DEFAULT_ENTITY_SCAN_CONFIG.windowMaxMessages,
    quietHoursTz:
      typeof obj.quietHoursTz === 'string'
        ? obj.quietHoursTz
        : DEFAULT_ENTITY_SCAN_CONFIG.quietHoursTz,
    quietHoursStart:
      typeof obj.quietHoursStart === 'number'
        ? obj.quietHoursStart
        : DEFAULT_ENTITY_SCAN_CONFIG.quietHoursStart,
    quietHoursEnd:
      typeof obj.quietHoursEnd === 'number'
        ? obj.quietHoursEnd
        : DEFAULT_ENTITY_SCAN_CONFIG.quietHoursEnd,
  };
}
