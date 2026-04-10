/**
 * Entity-scan queue — host-side append-only log of messages awaiting
 * conversation-window batching. Each row represents one inbound message
 * from any Telegram topic (not just wiki-inbox).
 *
 * Flow:
 *   1. container-runner.ts appends one row per spawn via enqueueMessage()
 *   2. entity-scan.ts (cron) reads the queue, groups rows into closed
 *      windows (60s idle OR 10-msg hard-flush), runs each closed window
 *      through pre-filter + LLM, and marks its rows processed.
 *   3. A nightly compaction job (or just a bounded tail) keeps the file
 *      from growing unbounded.
 *
 * The queue lives per-group at `<group>/wiki/.openclaw-wiki/entity-queue.jsonl`
 * so each group's conversations are isolated. The entity-scan CLI walks
 * all groups that have a vault.
 *
 * Format (one JSON object per line):
 *   { ts, groupFolder, chatJid, messageId, sender, snippet, processed? }
 *
 * `messageId` is synthesized from ts + a short hash of the snippet — we
 * don't currently thread Telegram message IDs into ContainerInput. Good
 * enough for de-duplication and ordering.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { vaultPaths } from './paths.js';

export interface EntityQueueRow {
  /** ISO-8601 timestamp with millis. */
  ts: string;
  /** Group folder name (e.g. "telegram_family"). Matches RegisteredGroup.folder. */
  groupFolder: string;
  /** Channel-specific chat identifier (e.g. Telegram JID). */
  chatJid: string;
  /** Synthesised message id: `<epochMs>-<snippetHash8>`. */
  messageId: string;
  /** Free-form sender label (assistantName or 'user'). */
  sender: string;
  /** Verbatim prompt text, truncated to ~4k chars. */
  snippet: string;
  /** Set to true once entity-scan has consumed this row. */
  processed?: boolean;
}

const MAX_SNIPPET_CHARS = 4000;

function entityQueuePath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'entity-queue.jsonl');
}

function shortHash(s: string): string {
  // Tiny deterministic fingerprint — not crypto, just enough to deduplicate
  // identical snippets that arrive in the same millisecond.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildRow(input: {
  groupFolder: string;
  chatJid: string;
  sender: string;
  snippet: string;
  ts?: Date;
}): EntityQueueRow {
  const ts = (input.ts ?? new Date()).toISOString();
  const snippet = input.snippet.slice(0, MAX_SNIPPET_CHARS);
  const messageId = `${Date.parse(ts)}-${shortHash(snippet)}`;
  return {
    ts,
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    messageId,
    sender: input.sender,
    snippet,
  };
}

/**
 * Append a row to the queue. Creates the state directory and file if
 * missing. Uses plain appendFileSync (not atomic) because append writes
 * to a single open file descriptor are atomic for small lines on POSIX
 * and we want zero-delay enqueue on the hot path.
 */
export function enqueueMessage(
  vaultPath: string,
  row: EntityQueueRow,
): void {
  const file = entityQueuePath(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

/**
 * Read all rows in the queue. Malformed lines are skipped silently —
 * a partial line from a torn write is recoverable on the next flush.
 */
export function readQueue(vaultPath: string): EntityQueueRow[] {
  const file = entityQueuePath(vaultPath);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const rows: EntityQueueRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as EntityQueueRow);
    } catch {
      // Torn write — skip.
    }
  }
  return rows;
}

/**
 * Rewrite the queue, keeping only unprocessed rows. Called by entity-scan
 * after it has flushed closed windows. Uses atomicWriteFile so a crash
 * mid-compaction never corrupts the queue.
 */
export function compactQueue(vaultPath: string, rows: EntityQueueRow[]): void {
  const file = entityQueuePath(vaultPath);
  const lines = rows.map((r) => JSON.stringify(r)).join('\n');
  atomicWriteFile(file, lines.length > 0 ? lines + '\n' : '');
}

export function getEntityQueuePath(vaultPath: string): string {
  return entityQueuePath(vaultPath);
}
