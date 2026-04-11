/**
 * macOS AddressBook contact resolver. Ports the contact-extraction
 * logic from llm-wiki's ingest_imessage.py.
 *
 * The macOS Contacts app stores records in multiple SQLite databases:
 *   - ~/Library/Application Support/AddressBook/AddressBook-v22.abcddb  (main)
 *   - ~/Library/Application Support/AddressBook/Sources/<uuid>/AddressBook-v22.abcddb
 *     (one per iCloud account / sync source)
 *
 * We read every source database we can find and merge the results
 * into a single phone/email → display-name map. Read-only.
 *
 * Requires Full Disk Access granted to the terminal app running this.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

export type ContactMap = Map<string, string>;

const ADDRESSBOOK_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'AddressBook',
);

/**
 * Normalize a phone number for lookup. Strips all non-digit characters,
 * then strips the US leading `1` so `+1 (555) 123-4567` and `5551234567`
 * both resolve the same way. Returns the last 10 digits as a canonical
 * key, or null for obviously invalid input.
 */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (digits.length >= 10) return digits.slice(-10);
  if (digits.length >= 7) return digits;
  return null;
}

/**
 * Find every AddressBook SQLite file. Returns an empty list if the
 * directory doesn't exist (non-macOS or unprivileged session).
 */
function findAddressBookDbs(): string[] {
  const out: string[] = [];
  if (!fs.existsSync(ADDRESSBOOK_DIR)) return out;

  const main = path.join(ADDRESSBOOK_DIR, 'AddressBook-v22.abcddb');
  if (fs.existsSync(main)) out.push(main);

  const sourcesDir = path.join(ADDRESSBOOK_DIR, 'Sources');
  if (fs.existsSync(sourcesDir)) {
    for (const entry of fs.readdirSync(sourcesDir)) {
      const candidate = path.join(
        sourcesDir,
        entry,
        'AddressBook-v22.abcddb',
      );
      if (fs.existsSync(candidate)) out.push(candidate);
    }
  }

  return out;
}

/**
 * Extract all contacts from every discovered AddressBook database.
 * Keys are either normalized phone numbers (10-digit) or lowercased
 * email addresses; values are display names ("First Last").
 *
 * Silently skips databases that fail to open — some source DBs can be
 * locked or corrupt without blocking the overall extraction.
 */
export function extractContacts(): ContactMap {
  const contacts: ContactMap = new Map();

  for (const dbPath of findAddressBookDbs()) {
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const people = new Map<number, string>();
      const rows = db
        .prepare(
          `SELECT ROWID, ZFIRSTNAME, ZLASTNAME
             FROM ZABCDRECORD
            WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL`,
        )
        .all() as Array<{
        ROWID: number;
        ZFIRSTNAME: string | null;
        ZLASTNAME: string | null;
      }>;

      for (const row of rows) {
        const name = `${row.ZFIRSTNAME ?? ''} ${row.ZLASTNAME ?? ''}`.trim();
        if (name) people.set(row.ROWID, name);
      }

      const phones = db
        .prepare(
          `SELECT ZOWNER, ZFULLNUMBER
             FROM ZABCDPHONENUMBER
            WHERE ZFULLNUMBER IS NOT NULL`,
        )
        .all() as Array<{ ZOWNER: number; ZFULLNUMBER: string }>;

      for (const row of phones) {
        const owner = people.get(row.ZOWNER);
        if (!owner) continue;
        const norm = normalizePhone(row.ZFULLNUMBER);
        if (norm) contacts.set(norm, owner);
      }

      const emails = db
        .prepare(
          `SELECT ZOWNER, ZADDRESS
             FROM ZABCDEMAILADDRESS
            WHERE ZADDRESS IS NOT NULL`,
        )
        .all() as Array<{ ZOWNER: number; ZADDRESS: string }>;

      for (const row of emails) {
        const owner = people.get(row.ZOWNER);
        if (!owner) continue;
        contacts.set(row.ZADDRESS.toLowerCase().trim(), owner);
      }
    } catch {
      // skip unreadable source DB
    } finally {
      db?.close();
    }
  }

  return contacts;
}

/**
 * Resolve a chat handle (phone or email) to a display name using the
 * contact map. Falls back to a cleaned version of the handle itself if
 * no contact matches.
 */
export function resolveHandle(handle: string, contacts: ContactMap): string {
  if (handle.includes('@')) {
    const key = handle.toLowerCase().trim();
    const hit = contacts.get(key);
    if (hit) return hit;
    return handle.split('@')[0];
  }
  const norm = normalizePhone(handle);
  if (norm) {
    const hit = contacts.get(norm);
    if (hit) return hit;
  }
  return handle;
}
