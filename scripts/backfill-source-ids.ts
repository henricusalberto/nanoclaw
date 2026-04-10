/**
 * One-shot fixer: walks every auto-created candidate-processor page
 * and derives `sourceIds[]` from the `[Source: entity-scan, backfill:<basename>, ...]`
 * notes in each claim's evidence. Converts `backfill:<basename>` →
 * `source.<basename>` so the frontmatter cites the bridge source
 * pages it came from.
 *
 * Existed because the first candidate-processor run populated
 * evidence notes correctly but left frontmatter.sourceIds empty,
 * which tripped the `missing-source-ids` lint on all 206 newly-
 * created pages. Code in candidate-processor.ts is already fixed
 * for future runs; this script repairs history.
 */

import fs from 'fs';
import path from 'path';

import {
  parseWikiPage,
  serializeWikiPage,
  WikiClaim,
} from '../src/wiki/markdown.js';
import { atomicWriteFile } from '../src/wiki/fs-util.js';

const VAULT = process.argv[2] ?? 'groups/telegram_wiki-inbox/wiki';
const DIRS = [
  'people',
  'companies',
  'projects',
  'concepts',
  'entities',
  'originals',
];

const BACKFILL_NOTE_RE = /backfill:([^,\]\s]+)/;

let scanned = 0;
let fixed = 0;
let skipped = 0;

for (const dir of DIRS) {
  const dirPath = path.join(VAULT, dir);
  if (!fs.existsSync(dirPath)) continue;
  for (const name of fs.readdirSync(dirPath)) {
    if (!name.endsWith('.md') || name === 'index.md') continue;
    const filePath = path.join(dirPath, name);
    scanned++;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      skipped++;
      continue;
    }

    let parsed;
    try {
      parsed = parseWikiPage(raw);
    } catch {
      skipped++;
      continue;
    }

    const existingSourceIds = Array.isArray(parsed.frontmatter.sourceIds)
      ? (parsed.frontmatter.sourceIds as string[])
      : [];
    if (existingSourceIds.length > 0) {
      // Page already has sourceIds; don't disturb.
      skipped++;
      continue;
    }

    const claims = Array.isArray(parsed.frontmatter.claims)
      ? (parsed.frontmatter.claims as WikiClaim[])
      : [];

    const derived = new Set<string>();
    for (const claim of claims) {
      for (const ev of claim.evidence ?? []) {
        const note = typeof ev.note === 'string' ? ev.note : '';
        const m = BACKFILL_NOTE_RE.exec(note);
        if (m) derived.add(`source.${m[1]}`);
      }
    }

    // Originals carry the window id in frontmatter.sourceWindowId, not in
    // claim evidence notes.
    const swid = parsed.frontmatter.sourceWindowId;
    if (typeof swid === 'string' && swid.startsWith('backfill:')) {
      derived.add(`source.${swid.slice('backfill:'.length)}`);
    }

    if (derived.size === 0) {
      skipped++;
      continue;
    }

    parsed.frontmatter.sourceIds = Array.from(derived);
    atomicWriteFile(filePath, serializeWikiPage(parsed.frontmatter, parsed.body));
    fixed++;
  }
}

console.log(`Scanned: ${scanned}`);
console.log(`Fixed (sourceIds backfilled): ${fixed}`);
console.log(`Skipped: ${skipped}`);
