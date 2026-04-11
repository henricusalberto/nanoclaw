/**
 * iMessage importer. Ports llm-wiki's `ingest_imessage.py` to
 * TypeScript against the NanoClaw wiki vault.
 *
 * Reads `~/Library/Messages/chat.db` read-only, filters to direct
 * messages from the top N contacts by volume, groups by day, and
 * writes one raw source page per (contact, day) into `sources/`.
 *
 * Requires Full Disk Access granted to the terminal/process running
 * this (System Settings → Privacy & Security → Full Disk Access).
 * Prints a clear error and exits 2 on permission failure.
 *
 * macOS only. On other platforms it reports and skips.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {
  ContactMap,
  extractContacts,
  resolveHandle,
} from './address-book.js';
import {
  RawEntryInput,
  RawMessage,
  slugifyContact,
  writeRawEntry,
} from './raw-entry-writer.js';

const IMESSAGE_DB = path.join(
  os.homedir(),
  'Library',
  'Messages',
  'chat.db',
);

/** Apple reference date: 2001-01-01 UTC in Unix seconds. */
const APPLE_EPOCH_OFFSET = 978307200;

export interface ImessageImportOptions {
  vaultPath: string;
  /** Only include messages on or after this ISO date (YYYY-MM-DD). */
  since: string;
  /** Top N contacts by message count. Default 100. */
  topN: number;
  /** Minimum message text length, in characters. Default 15. */
  minMessageLength: number;
  /** Display name for the user (shown as sender on their own messages). */
  yourName: string;
  /** When false, preview stats only and don't write any files. */
  apply: boolean;
}

export interface ImessageImportResult {
  platformOk: boolean;
  permissionOk: boolean;
  contactCount: number;
  topContactCount: number;
  entriesWritten: number;
  entriesUnchanged: number;
  messagesProcessed: number;
  sampleContacts: Array<{ name: string; messageCount: number }>;
  error?: string;
}

interface TopContactRow {
  chat_identifier: string;
  cnt: number;
}

interface MessageRow {
  msg_date: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: number;
}

/**
 * iOS 16+ stores plain text in a binary attributedBody blob when the
 * `text` column is NULL. This regex-extraction matches llm-wiki's
 * Python implementation; it's heuristic but works well enough in
 * practice to recover the body.
 */
function extractTextFromAttributedBody(blob: Buffer | null): string | null {
  if (!blob || blob.length === 0) return null;
  const decoded = blob.toString('utf-8');
  const match = decoded.match(/\+(.{2,2000}?)(?:iI|\x00\x00)/s);
  if (!match) return null;
  let text = match[1].trim();
  text = text.replace(/^[^\x20-\x7e]*/, '');
  text = text.replace(/\ufffd+$/, '').trim();
  if (text.length > 3) return text;
  return null;
}

const TAPBACK_PREFIXES = [
  'Liked "',
  'Loved "',
  'Laughed at "',
  'Emphasized "',
  'Disliked "',
  'Questioned "',
];

function isTapback(text: string): boolean {
  return TAPBACK_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function isoToAppleTsBoundary(iso: string): number {
  const unix = Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);
  return unix;
}

export function importImessage(
  options: ImessageImportOptions,
): ImessageImportResult {
  const result: ImessageImportResult = {
    platformOk: process.platform === 'darwin',
    permissionOk: false,
    contactCount: 0,
    topContactCount: 0,
    entriesWritten: 0,
    entriesUnchanged: 0,
    messagesProcessed: 0,
    sampleContacts: [],
  };

  if (!result.platformOk) {
    result.error = `imessage ingest is macOS-only (got ${process.platform})`;
    return result;
  }

  if (!fs.existsSync(IMESSAGE_DB)) {
    result.error = `iMessage database not found at ${IMESSAGE_DB}`;
    return result;
  }

  let contacts: ContactMap;
  try {
    contacts = extractContacts();
  } catch (err) {
    contacts = new Map();
    result.error = `AddressBook extraction failed: ${(err as Error).message}`;
  }
  result.contactCount = contacts.size;

  let db: Database.Database;
  try {
    db = new Database(IMESSAGE_DB, {
      readonly: true,
      fileMustExist: true,
    });
  } catch (err) {
    const msg = (err as Error).message;
    // SQLite's SQLITE_CANTOPEN on macOS maps to "unable to open database file"
    // when the process lacks Full Disk Access, which is the usual cause here.
    if (
      /unable to open database file|permission|denied|operation not permitted/i.test(
        msg,
      )
    ) {
      result.error =
        `cannot open ${IMESSAGE_DB}: ${msg}. This usually means your ` +
        `terminal needs Full Disk Access. Grant it in System Settings ` +
        `→ Privacy & Security → Full Disk Access, then retry. If you're ` +
        `running from a non-interactive process (cron, launchd), that ` +
        `process also needs Full Disk Access.`;
    } else {
      result.error = `failed to open chat.db: ${msg}`;
    }
    return result;
  }

  result.permissionOk = true;
  const sinceUnix = isoToAppleTsBoundary(options.since);

  try {
    const topContacts = db
      .prepare<[], TopContactRow>(
        `SELECT c.chat_identifier, COUNT(*) as cnt
           FROM message m, chat_message_join cmj, chat c
          WHERE cmj.message_id = m.ROWID
            AND c.ROWID = cmj.chat_id
            AND c.chat_identifier NOT LIKE 'chat%'
            AND (m.date/1000000000 + ${APPLE_EPOCH_OFFSET}) > ${sinceUnix}
          GROUP BY c.chat_identifier
          ORDER BY cnt DESC
          LIMIT ${options.topN}`,
      )
      .all();

    result.topContactCount = topContacts.length;

    result.sampleContacts = topContacts.slice(0, 10).map((row) => ({
      name: resolveHandle(row.chat_identifier, contacts),
      messageCount: row.cnt,
    }));

    const msgStmt = db.prepare<
      [string, number],
      MessageRow
    >(
      `SELECT
            datetime(m.date/1000000000 + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime') as msg_date,
            m.text,
            m.attributedBody,
            m.is_from_me
          FROM message m
          JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE c.chat_identifier = ?
           AND (m.date/1000000000 + ${APPLE_EPOCH_OFFSET}) > ?
           AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
         ORDER BY m.date`,
    );

    for (const contact of topContacts) {
      const name = resolveHandle(contact.chat_identifier, contacts);
      const contactSlug = slugifyContact(name) || slugifyContact(contact.chat_identifier);
      if (!contactSlug) continue;

      const messages = msgStmt.all(contact.chat_identifier, sinceUnix);

      const byDay = new Map<string, RawMessage[]>();
      for (const row of messages) {
        if (!row.msg_date) continue;
        const body =
          row.text ?? extractTextFromAttributedBody(row.attributedBody);
        if (!body || body.length < options.minMessageLength) continue;
        if (isTapback(body)) continue;

        const day = row.msg_date.slice(0, 10);
        const time = row.msg_date.slice(11, 19);
        const sender = row.is_from_me ? options.yourName : name;

        const bucket = byDay.get(day) ?? [];
        bucket.push({ time, sender, text: body });
        byDay.set(day, bucket);
      }

      for (const [day, dayMsgs] of [...byDay.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        if (dayMsgs.length < 2) continue;

        const input: RawEntryInput = {
          contactSlug,
          contactName: name,
          day,
          sourceType: 'imessage',
          sourceLabel: 'iMessage',
          messages: dayMsgs,
        };

        const status = writeRawEntry(options.vaultPath, input, {
          dryRun: !options.apply,
        });
        if (status === 'written') {
          result.entriesWritten++;
          result.messagesProcessed += dayMsgs.length;
        } else if (status === 'unchanged') {
          result.entriesUnchanged++;
        } else {
          // dry-run preview
          result.entriesWritten++;
          result.messagesProcessed += dayMsgs.length;
        }
      }
    }
  } finally {
    db.close();
  }

  return result;
}
