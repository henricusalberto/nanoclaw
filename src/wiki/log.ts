/**
 * Append-only event log. Each line is a JSON `{ts, type, data}` event.
 * Single-line writes <= 4096 bytes are atomic on POSIX (PIPE_BUF guarantee),
 * so concurrent appenders don't interleave. Callers must keep events small
 * and cap any embedded arrays.
 */

import fs from 'fs';

import { vaultPaths } from './paths.js';

export type WikiLogEventType =
  | 'init'
  | 'ingest'
  | 'compile'
  | 'lint'
  | 'bridge-sync'
  | 'apply'
  | 'migration';

export interface WikiLogEvent {
  ts: string;
  type: WikiLogEventType;
  data: Record<string, unknown>;
}

export function getWikiLogPath(vaultPath: string): string {
  return vaultPaths(vaultPath).log;
}

// Hard cap on serialized event size to keep appends below PIPE_BUF.
const MAX_EVENT_BYTES = 3500;

export function appendWikiLogEvent(
  vaultPath: string,
  type: WikiLogEventType,
  data: Record<string, unknown> = {},
): void {
  const logPath = getWikiLogPath(vaultPath);
  fs.mkdirSync(vaultPaths(vaultPath).stateDir, { recursive: true });
  const event: WikiLogEvent = { ts: new Date().toISOString(), type, data };
  let line = JSON.stringify(event) + '\n';
  if (line.length > MAX_EVENT_BYTES) {
    // Truncate by replacing the data with a stub. Rare but defends against
    // torn writes when an event accidentally embeds a giant array.
    line = JSON.stringify({
      ts: event.ts,
      type: event.type,
      data: { _truncated: true, originalKeys: Object.keys(data) },
    }) + '\n';
  }
  fs.appendFileSync(logPath, line);
}

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
      // graceful: corruption shouldn't break readers
    }
  }
  return events;
}

export function readRecentWikiLogEvents(
  vaultPath: string,
  count: number,
): WikiLogEvent[] {
  return readWikiLogEvents(vaultPath).slice(-count);
}
