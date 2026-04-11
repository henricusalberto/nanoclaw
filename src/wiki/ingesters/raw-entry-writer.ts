/**
 * Shared raw-entry writer for message-archive ingesters (iMessage,
 * WhatsApp, email). Ports the pattern from farza's gbrain / llm-wiki:
 * one markdown file per (contact, day) grouping, stored under the
 * vault's `sources/` directory, immutable after write.
 *
 * Raw entries are treated as source-of-truth input. The dream cycle
 * and Janus absorb them into structured entity pages later; this
 * writer does not interpret the content.
 */

import path from 'path';
import { atomicWriteFile } from '../fs-util.js';

export interface RawMessage {
  /** HH:MM:SS localtime string */
  time: string;
  /** Display name of the sender (either `yourName` or the counterparty) */
  sender: string;
  /** The message body — already filtered for min length and reaction noise */
  text: string;
}

export interface RawEntryInput {
  /**
   * Stable slug for the counterparty contact (e.g. `dom-ingleston`).
   * Used in both the file name and the wiki page id.
   */
  contactSlug: string;
  /** Display name for the counterparty (for title + frontmatter) */
  contactName: string;
  /** YYYY-MM-DD */
  day: string;
  /** Channel slug — `imessage`, `whatsapp`, `email`, etc. */
  sourceType: string;
  /** Human-friendly channel label used in the title */
  sourceLabel: string;
  /** Already-sorted messages for the day */
  messages: RawMessage[];
}

export function rawEntryId(input: RawEntryInput): string {
  return `source.${input.sourceType}-${input.contactSlug}-${input.day}`;
}

export function rawEntryFileName(input: RawEntryInput): string {
  return `${input.sourceType}-${input.contactSlug}-${input.day}.md`;
}

export function rawEntryAbsPath(
  vaultPath: string,
  input: RawEntryInput,
): string {
  return path.join(vaultPath, 'sources', rawEntryFileName(input));
}

export function renderRawEntry(input: RawEntryInput): string {
  const id = rawEntryId(input);
  const title = `${input.sourceLabel} with ${input.contactName} (${input.day})`;
  const firstTime = input.messages[0]?.time ?? '00:00:00';
  const ingestedAt = new Date().toISOString();

  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: ${id}`);
  lines.push('pageType: source');
  lines.push(`title: "${escapeYamlDouble(title)}"`);
  lines.push('sourceIds: []');
  lines.push('claims: []');
  lines.push('contradictions: []');
  lines.push('questions: []');
  lines.push('confidence: 1');
  lines.push('status: active');
  lines.push(`sourceType: ${input.sourceType}`);
  lines.push(`participant: "${escapeYamlDouble(input.contactName)}"`);
  lines.push(`participantSlug: ${input.contactSlug}`);
  lines.push(`date: ${input.day}`);
  lines.push(`time: "${firstTime}"`);
  lines.push(`messageCount: ${input.messages.length}`);
  lines.push(`ingestedAt: "${ingestedAt}"`);
  lines.push(`updatedAt: "${ingestedAt}"`);
  lines.push('bridgeAgentIds: []');
  lines.push('tags:');
  lines.push(`  - ${input.sourceType}`);
  lines.push('  - raw-message-archive');
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    '_Raw message archive entry — immutable after ingest. Do not edit by hand._',
  );
  lines.push('');

  for (const msg of input.messages) {
    lines.push(`**${msg.sender}** (${msg.time}): ${msg.text}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write a raw entry to disk. Idempotent when the body is unchanged —
 * re-runs produce the same file.
 *
 * Returns `'written'` on first write, `'unchanged'` on a no-op rerun.
 * The `ingestedAt` / `updatedAt` timestamps are excluded from the
 * unchanged check so reruns don't churn mtimes.
 */
export function writeRawEntry(
  vaultPath: string,
  input: RawEntryInput,
  options: { dryRun: boolean },
): 'written' | 'unchanged' | 'dry-run' {
  const absPath = rawEntryAbsPath(vaultPath, input);
  const body = renderRawEntry(input);

  if (options.dryRun) return 'dry-run';

  // Stable comparison: strip the timestamp lines so idempotent reruns
  // don't rewrite the file.
  const stripTimestamps = (s: string): string =>
    s
      .split('\n')
      .filter(
        (l) => !l.startsWith('ingestedAt: ') && !l.startsWith('updatedAt: '),
      )
      .join('\n');

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    if (fs.existsSync(absPath)) {
      const existing = fs.readFileSync(absPath, 'utf-8');
      if (stripTimestamps(existing) === stripTimestamps(body)) {
        return 'unchanged';
      }
    }
  } catch {
    // fall through to write
  }

  atomicWriteFile(absPath, body);
  return 'written';
}

function escapeYamlDouble(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function slugifyContact(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}
