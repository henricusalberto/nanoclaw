/**
 * Append-only event log for wiki state.
 *
 * Path: <vaultPath>/.openclaw-wiki/log.jsonl
 * Format: one JSON event per line, schema { ts, type, data }
 *
 * Atomic-append via write+rename of the whole file is wasteful. We use
 * fs.appendFileSync which is atomic on POSIX for writes <= PIPE_BUF (4096
 * bytes), and our events are well under that. Each event is serialized to
 * a single line so partial writes don't corrupt the file.
 */

import fs from 'fs';
import path from 'path';

export type WikiLogEventType =
  | 'init'
  | 'ingest'
  | 'compile'
  | 'lint'
  | 'bridge-sync'
  | 'apply'
  | 'migration';

export interface WikiLogEvent {
  ts: string; // ISO 8601
  type: WikiLogEventType;
  data: Record<string, unknown>;
}

const LOG_RELATIVE_PATH = '.openclaw-wiki/log.jsonl';

export function getWikiLogPath(vaultPath: string): string {
  return path.join(vaultPath, LOG_RELATIVE_PATH);
}

/**
 * Append a single event to the wiki log.
 *
 * @param vaultPath  absolute path to the wiki root (the dir containing .openclaw-wiki/)
 * @param type       event type
 * @param data       arbitrary JSON-serializable payload
 */
export function appendWikiLogEvent(
  vaultPath: string,
  type: WikiLogEventType,
  data: Record<string, unknown> = {},
): void {
  const logPath = getWikiLogPath(vaultPath);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const event: WikiLogEvent = {
    ts: new Date().toISOString(),
    type,
    data,
  };
  // Single-line JSON ensures atomic append on POSIX (under PIPE_BUF)
  const line = JSON.stringify(event) + '\n';
  fs.appendFileSync(logPath, line);
}

/**
 * Read all events from the log. Used by lint, dashboards, and debugging.
 * Returns events in chronological order (oldest first).
 */
export function readWikiLogEvents(vaultPath: string): WikiLogEvent[] {
  const logPath = getWikiLogPath(vaultPath);
  if (!fs.existsSync(logPath)) return [];
  const content = fs.readFileSync(logPath, 'utf-8');
  const events: WikiLogEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as WikiLogEvent);
    } catch {
      // Skip malformed lines (graceful — corruption shouldn't break readers)
    }
  }
  return events;
}

/**
 * Read the most recent N events. Useful for status displays.
 */
export function readRecentWikiLogEvents(
  vaultPath: string,
  count: number,
): WikiLogEvent[] {
  const all = readWikiLogEvents(vaultPath);
  return all.slice(-count);
}
