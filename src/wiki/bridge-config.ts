/**
 * Bridge configuration: which paths to scan and how to classify them.
 *
 * Lives at <vaultPath>/.openclaw-wiki/bridge.json. Editable by the user.
 */

import fs from 'fs';
import path from 'path';

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

export interface BridgeConfig {
  vaultMode: 'bridge';
  ingest: {
    autoCompile: boolean;
    autoIngest: boolean;
  };
  sources: BridgeSourceConfig[];
}

const CONFIG_RELATIVE_PATH = '.openclaw-wiki/bridge.json';

export function getBridgeConfigPath(vaultPath: string): string {
  return path.join(vaultPath, CONFIG_RELATIVE_PATH);
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

export function readBridgeConfig(vaultPath: string): BridgeConfig {
  const p = getBridgeConfigPath(vaultPath);
  if (!fs.existsSync(p)) {
    return DEFAULT_BRIDGE_CONFIG;
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw);
    return validateBridgeConfig(parsed);
  } catch {
    return DEFAULT_BRIDGE_CONFIG;
  }
}

export function writeBridgeConfig(
  vaultPath: string,
  config: BridgeConfig,
): void {
  const p = getBridgeConfigPath(vaultPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
}

export function ensureBridgeConfig(vaultPath: string): BridgeConfig {
  const p = getBridgeConfigPath(vaultPath);
  if (!fs.existsSync(p)) {
    writeBridgeConfig(vaultPath, DEFAULT_BRIDGE_CONFIG);
    return DEFAULT_BRIDGE_CONFIG;
  }
  return readBridgeConfig(vaultPath);
}

function validateBridgeConfig(parsed: unknown): BridgeConfig {
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
  return {
    vaultMode: 'bridge',
    ingest: {
      autoCompile: ingest.autoCompile ?? true,
      autoIngest: ingest.autoIngest ?? true,
    },
    sources,
  };
}
