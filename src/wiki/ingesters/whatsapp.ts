/**
 * WhatsApp importer. Ports llm-wiki's `ingest_whatsapp.py` to
 * TypeScript against the NanoClaw wiki vault.
 *
 * Reads the WhatsApp desktop app's `ChatStorage.sqlite` read-only,
 * filters to direct messages only (group chats have a JID suffix of
 * `@g.us`), groups by day, and writes one raw source page per
 * (contact, day) into `sources/`.
 *
 * Requires the WhatsApp desktop app to be installed and synced.
 * macOS only.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import {
  RawEntryInput,
  RawMessage,
  slugifyContact,
  writeRawEntry,
} from './raw-entry-writer.js';

const WA_DB = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.net.whatsapp.WhatsApp.shared',
  'ChatStorage.sqlite',
);

/** Apple reference date: 2001-01-01 UTC in Unix seconds. */
const APPLE_EPOCH_OFFSET = 978307200;

export interface WhatsappImportOptions {
  vaultPath: string;
  topN: number;
  minMessageLength: number;
  yourName: string;
  apply: boolean;
}

export interface WhatsappImportResult {
  platformOk: boolean;
  dbFound: boolean;
  topContactCount: number;
  entriesWritten: number;
  entriesUnchanged: number;
  messagesProcessed: number;
  sampleContacts: Array<{ name: string; messageCount: number }>;
  error?: string;
}

interface TopContactRow {
  Z_PK: number;
  ZPARTNERNAME: string;
  ZCONTACTJID: string;
  cnt: number;
}

interface MessageRow {
  msg_date: string | null;
  ZTEXT: string | null;
  ZISFROMME: number;
}

export function importWhatsapp(
  options: WhatsappImportOptions,
): WhatsappImportResult {
  const result: WhatsappImportResult = {
    platformOk: process.platform === 'darwin',
    dbFound: false,
    topContactCount: 0,
    entriesWritten: 0,
    entriesUnchanged: 0,
    messagesProcessed: 0,
    sampleContacts: [],
  };

  if (!result.platformOk) {
    result.error = `whatsapp ingest is macOS-only (got ${process.platform})`;
    return result;
  }

  if (!fs.existsSync(WA_DB)) {
    result.error = `WhatsApp database not found at ${WA_DB}. Install WhatsApp Desktop and sync at least once.`;
    return result;
  }
  result.dbFound = true;

  let db: Database.Database;
  try {
    db = new Database(WA_DB, { readonly: true, fileMustExist: true });
  } catch (err) {
    result.error = `failed to open ChatStorage.sqlite: ${(err as Error).message}`;
    return result;
  }

  try {
    const topContacts = db
      .prepare<[], TopContactRow>(
        `SELECT cs.Z_PK, cs.ZPARTNERNAME, cs.ZCONTACTJID, COUNT(*) as cnt
           FROM ZWAMESSAGE m
           JOIN ZWACHATSESSION cs ON m.ZCHATSESSION = cs.Z_PK
          WHERE cs.ZPARTNERNAME IS NOT NULL
            AND cs.ZCONTACTJID NOT LIKE '%@g.us'
          GROUP BY cs.Z_PK
          ORDER BY cnt DESC
          LIMIT ${options.topN}`,
      )
      .all();

    result.topContactCount = topContacts.length;
    result.sampleContacts = topContacts.slice(0, 10).map((row) => ({
      name: row.ZPARTNERNAME,
      messageCount: row.cnt,
    }));

    const msgStmt = db.prepare<
      [number, number],
      MessageRow
    >(
      `SELECT
            datetime(m.ZMESSAGEDATE + ${APPLE_EPOCH_OFFSET}, 'unixepoch', 'localtime') as msg_date,
            m.ZTEXT,
            m.ZISFROMME
          FROM ZWAMESSAGE m
         WHERE m.ZCHATSESSION = ?
           AND m.ZTEXT IS NOT NULL
           AND LENGTH(m.ZTEXT) > ?
         ORDER BY m.ZMESSAGEDATE`,
    );

    for (const contact of topContacts) {
      const name = contact.ZPARTNERNAME;
      const contactSlug = slugifyContact(name);
      if (!contactSlug) continue;

      const messages = msgStmt.all(contact.Z_PK, options.minMessageLength);

      const byDay = new Map<string, RawMessage[]>();
      for (const row of messages) {
        if (!row.msg_date || !row.ZTEXT) continue;
        const day = row.msg_date.slice(0, 10);
        const time = row.msg_date.slice(11, 19);
        const sender = row.ZISFROMME ? options.yourName : name;
        const bucket = byDay.get(day) ?? [];
        bucket.push({ time, sender, text: row.ZTEXT });
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
          sourceType: 'whatsapp',
          sourceLabel: 'WhatsApp',
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
