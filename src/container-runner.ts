/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  QMD_HOST_DIR,
  QMD_WORKSPACE_DIR,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { syncWikiBridge } from './wiki/bridge.js';
import { readBridgeConfig } from './wiki/bridge-config.js';
import { buildRow, enqueueMessage } from './wiki/entity-queue.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  model?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the OneCLI gateway, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }

    // Wiki-inbox vault — writable so main-group cron tasks (entity-scan,
    // dream-cycle, bookmark-sync) can produce candidates, shadow files,
    // and source pages. The /workspace/project mount is read-only so
    // these writes would otherwise fail.
    const wikiInboxDir = path.join(GROUPS_DIR, 'telegram_wiki-inbox');
    if (fs.existsSync(wikiInboxDir)) {
      mounts.push({
        hostPath: wikiInboxDir,
        containerPath: '/workspace/wiki-inbox',
        readonly: false,
      });
    }
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Overlay learned skills from the group workspace on top of built-ins.
  // Copied second so they override any built-in with the same name.
  const learnedSkillsSrc = path.join(groupDir, 'skills');
  if (fs.existsSync(learnedSkillsSrc)) {
    for (const skillDir of fs.readdirSync(learnedSkillsSrc)) {
      const srcDir = path.join(learnedSkillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Compare newest mtime across the entire source tree, not just index.ts.
    // A previous version only checked index.ts, which silently missed
    // newly-added sibling files (e.g. ipc-mcp-stdio.ts) and left groups
    // running stale agent-runner code with missing MCP tools.
    const newestMtime = (dir: string): number => {
      let max = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        const m = entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs;
        if (m > max) max = m;
      }
      return max;
    };
    const srcMtime = newestMtime(agentRunnerSrc);
    const cachedMtime = fs.existsSync(groupAgentRunnerDir)
      ? newestMtime(groupAgentRunnerDir)
      : 0;
    if (srcMtime > cachedMtime) {
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // QMD: mount the host's qmd cache/config directory and the indexed workspace
  // at the SAME absolute paths inside the container. The qmd index stores
  // absolute file references (e.g. /Users/.../workspace/...), so mounting at
  // the same path is the simplest way to keep `qmd query` and `qmd get`
  // functional without re-indexing. The agent runner connects to qmd via
  // stdio MCP (see container/agent-runner/src/index.ts), pointing XDG_*_HOME
  // at the mounted directories.
  if (fs.existsSync(QMD_HOST_DIR)) {
    mounts.push({
      hostPath: QMD_HOST_DIR,
      containerPath: QMD_HOST_DIR,
      // Read-write so qmd can append to its mcp.log files. The container
      // never runs `qmd update`, so the index itself isn't mutated from here.
      readonly: false,
    });
    if (fs.existsSync(QMD_WORKSPACE_DIR)) {
      mounts.push({
        hostPath: QMD_WORKSPACE_DIR,
        containerPath: QMD_WORKSPACE_DIR,
        readonly: true,
      });
    }
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);

    // Stub-venv overlays for OpenClaw backwards compatibility.
    // Mac-built Python venvs don't run inside the Linux container, so we
    // shadow each discovered venv with a host stub-venv directory whose
    // bin/python forwards to the container's system Python (which has
    // the required packages installed by the Dockerfile).
    // Only mounts using mountAtHostPath are scanned, since only those expose
    // their venvs at the original absolute paths the cron prompts use.
    const stubVenv = ensureStubVenv();
    for (const m of group.containerConfig.additionalMounts) {
      if (!m.mountAtHostPath) continue;
      const realRoot = (() => {
        try {
          const expanded = m.hostPath.startsWith('~/')
            ? path.join(process.env.HOME || os.homedir(), m.hostPath.slice(2))
            : m.hostPath;
          return fs.realpathSync(expanded);
        } catch {
          return null;
        }
      })();
      if (!realRoot) continue;
      for (const venvPath of findVenvs(realRoot, 5)) {
        mounts.push({
          hostPath: stubVenv,
          containerPath: venvPath, // shadow the Mac venv at the same absolute path
          readonly: true,
        });
      }
    }
  }

  // Deduplicate by containerPath: later entries win. This lets a mountAtHostPath
  // workspace mount (read-write) override the read-only QMD workspace mount that
  // targets the same absolute path, and lets stub-venv overlays cleanly shadow
  // any earlier mount of the same venv path.
  const dedup = new Map<string, VolumeMount>();
  for (const m of mounts) {
    dedup.set(m.containerPath, m);
  }
  return Array.from(dedup.values());
}

/**
 * Recursively find directories containing pyvenv.cfg under root, up to maxDepth.
 * Skips common heavy directories. Returns absolute paths.
 */
function findVenvs(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  const skip = new Set([
    'node_modules',
    '.git',
    '__pycache__',
    '.cache',
    'dist',
    'build',
    '.next',
  ]);
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // If this directory is itself a venv, record it and don't descend.
    if (entries.some((e) => e.name === 'pyvenv.cfg' && e.isFile())) {
      results.push(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return results;
}

/**
 * Ensure a host-side stub-venv directory exists in DATA_DIR. Returns the path.
 * The stub contains symlinks targeting absolute container paths
 * (/usr/bin/python3, /usr/bin/pip3) — these only resolve correctly inside
 * the container, which is fine: that's the only place they're read.
 */
let stubVenvPath: string | null = null;
function ensureStubVenv(): string {
  if (stubVenvPath) return stubVenvPath;
  const dir = path.join(DATA_DIR, 'stub-venv');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const ensureSymlink = (target: string, linkPath: string) => {
    try {
      const current = fs.readlinkSync(linkPath);
      if (current === target) return;
      fs.unlinkSync(linkPath);
    } catch {
      // doesn't exist
    }
    fs.symlinkSync(target, linkPath);
  };
  ensureSymlink('/usr/bin/python3', path.join(binDir, 'python'));
  ensureSymlink('/usr/bin/python3', path.join(binDir, 'python3'));
  ensureSymlink('/usr/bin/pip3', path.join(binDir, 'pip'));
  ensureSymlink('/usr/bin/pip3', path.join(binDir, 'pip3'));

  const activate = path.join(binDir, 'activate');
  const activateBody =
    '# nanoclaw stub venv — no-op activate (forwards to container system Python)\n' +
    'export VIRTUAL_ENV=/opt/nanoclaw/stub-venv\n' +
    'export PATH="$VIRTUAL_ENV/bin:$PATH"\n';
  if (
    !fs.existsSync(activate) ||
    fs.readFileSync(activate, 'utf-8') !== activateBody
  ) {
    fs.writeFileSync(activate, activateBody);
    fs.chmodSync(activate, 0o755);
  }

  // Minimal pyvenv.cfg so anything that introspects the venv sees it as valid.
  const cfg = path.join(dir, 'pyvenv.cfg');
  const cfgBody = 'home = /usr/bin\nversion = 3.11\nstub = nanoclaw\n';
  if (!fs.existsSync(cfg) || fs.readFileSync(cfg, 'utf-8') !== cfgBody) {
    fs.writeFileSync(cfg, cfgBody);
  }

  stubVenvPath = dir;
  return dir;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Sunsama: long-lived bearer token for the official remote MCP server.
  // Stored in the OpenClaw-shared secrets dir so OpenClaw can read the same
  // file. Injected as an env var so the agent-runner can register the HTTP
  // MCP server with an Authorization header — never written to disk inside
  // the container, never persisted in process.env on the host.
  const sunsamaSecretFile = path.join(
    os.homedir(),
    '.openclaw',
    'workspace',
    'secrets',
    'sunsama.env',
  );
  const sunsamaEnv = readEnvFile(['SUNSAMA_BEARER_TOKEN'], sunsamaSecretFile);
  if (sunsamaEnv.SUNSAMA_BEARER_TOKEN) {
    args.push('-e', `SUNSAMA_BEARER_TOKEN=${sunsamaEnv.SUNSAMA_BEARER_TOKEN}`);
  }

  // QMD: tell the in-container agent runner where to find the qmd index/config
  // when it spawns `qmd mcp` as a stdio MCP server.
  if (fs.existsSync(QMD_HOST_DIR)) {
    args.push(
      '-e',
      `NANOCLAW_QMD_XDG_CACHE_HOME=${path.join(QMD_HOST_DIR, 'xdg-cache')}`,
    );
    args.push(
      '-e',
      `NANOCLAW_QMD_XDG_CONFIG_HOME=${path.join(QMD_HOST_DIR, 'xdg-config')}`,
    );
  }

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    logger.info({ containerName }, 'OneCLI gateway config applied');
  } else {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — container will have no credentials',
    );
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

/**
 * Shared wiki-inbox vault path. All groups' entity-scan queue rows land
 * in this single vault so the scanner only has one place to look.
 *
 * Cached after first resolution: the vault location doesn't change at
 * runtime, and the previous implementation paid an `fs.existsSync` stat
 * per inbound message.
 */
let cachedWikiInboxVaultPath: { path: string | null } | null = null;
function wikiInboxVaultPath(): string | null {
  if (cachedWikiInboxVaultPath) return cachedWikiInboxVaultPath.path;
  const p = path.join(process.cwd(), 'groups', 'telegram_wiki-inbox', 'wiki');
  const state = path.join(p, '.openclaw-wiki');
  const resolved = fs.existsSync(state) ? p : null;
  cachedWikiInboxVaultPath = { path: resolved };
  return resolved;
}

/**
 * Append this spawn's inbound message to the entity-scan queue. Best
 * effort — any failure is logged and swallowed. Gated by the vault's
 * entityScan.enabled config so users who haven't opted in pay nothing.
 *
 * Scheduled-task spawns are skipped: the queue is for human conversation
 * windows, not autonomous cron wake-ups.
 */
function maybeEnqueueForEntityScan(
  group: RegisteredGroup,
  input: ContainerInput,
): void {
  if (input.isScheduledTask) return;
  const vaultPath = wikiInboxVaultPath();
  if (!vaultPath) return;
  try {
    const cfg = readBridgeConfig(vaultPath);
    if (!cfg.entityScan?.enabled) return;
    const row = buildRow({
      groupFolder: group.folder,
      chatJid: input.chatJid,
      sender: input.assistantName ?? 'user',
      snippet: input.prompt,
    });
    enqueueMessage(vaultPath, row);
  } catch (err) {
    logger.warn(
      { group: group.folder, err: String(err) },
      'entity-scan enqueue failed (non-fatal)',
    );
  }
}

/**
 * Run the wiki bridge sync if this group's directory contains a wiki vault
 * with a `.openclaw-wiki/` state directory. Errors are logged but never
 * propagated — bridge failures must not block container spawns.
 */
async function maybeRunWikiBridgeSync(group: RegisteredGroup): Promise<void> {
  const groupDir = resolveGroupFolderPath(group.folder);
  const vaultPath = path.join(groupDir, 'wiki');
  const stateDir = path.join(vaultPath, '.openclaw-wiki');
  if (!fs.existsSync(stateDir)) return;
  try {
    const result = await syncWikiBridge(vaultPath, process.cwd());
    if (
      result.importedCount > 0 ||
      result.updatedCount > 0 ||
      result.removedCount > 0
    ) {
      logger.info(
        {
          group: group.folder,
          imported: result.importedCount,
          updated: result.updatedCount,
          removed: result.removedCount,
          skipped: result.skippedCount,
          durationMs: result.durationMs,
        },
        'Wiki bridge sync',
      );
    } else {
      logger.debug(
        {
          group: group.folder,
          skipped: result.skippedCount,
          durationMs: result.durationMs,
        },
        'Wiki bridge sync (no changes)',
      );
    }
  } catch (err) {
    logger.warn(
      { group: group.folder, err: String(err) },
      'Wiki bridge sync failed (continuing with container spawn)',
    );
  }
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Wiki bridge sync — runs before spawning the container for any group
  // whose vault directory contains a `.openclaw-wiki/` state dir. Cheap
  // when nothing has changed (just stats + JSON read), so safe to call
  // unconditionally on every spawn. See src/wiki/bridge.ts.
  await maybeRunWikiBridgeSync(group);

  // Phase 2: append this message to the entity-scan queue. The scanner
  // runs on its own cron; this hook only does an O(line) append.
  maybeEnqueueForEntityScan(group, input);

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  const containerArgs = await buildContainerArgs(
    mounts,
    containerName,
    agentIdentifier,
  );

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Allow per-group or global model override via .env keys.
    // Per-group key wins: NANOCLAW_MODEL_<UPPER_FOLDER_WITH_UNDERSCORES>
    // Falls back to NANOCLAW_MODEL_DEFAULT if no per-group override.
    // Read via readEnvFile so secrets stay out of process.env.
    let effectiveInput = input;
    if (!effectiveInput.model) {
      const groupKey =
        'NANOCLAW_MODEL_' +
        group.folder.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      const envValues = readEnvFile([groupKey, 'NANOCLAW_MODEL_DEFAULT']);
      const override = envValues[groupKey] || envValues.NANOCLAW_MODEL_DEFAULT;
      if (override) {
        effectiveInput = { ...effectiveInput, model: override };
        logger.info(
          { group: group.folder, model: override },
          'Model override applied',
        );
      }
    }

    container.stdin.write(JSON.stringify(effectiveInput));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
