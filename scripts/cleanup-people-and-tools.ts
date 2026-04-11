/**
 * One-shot cleanup for the two navigation papercuts:
 *
 *   1. Dedupe people — merge the short-name auto-stub pages
 *      (dom.md, nata.md, maurizio.md) into their canonical
 *      long-name counterparts (dom-ingleston.md, nata-luyindula.md,
 *      maurizio-faerber.md) and rewrite every wikilink in the vault
 *      to point at the survivor.
 *
 *   2. Reclassify tool pages — move gmail/gemini/sonnet/m1 from
 *      projects/ to concepts/. These are external tools, not things
 *      Maurizio is building. Updates pageType, frontmatter id, and
 *      physical file location. Basenames stay the same so no
 *      wikilink rewriting is needed.
 *
 * Both phases are idempotent: running twice after success is a no-op.
 */

import fs from 'fs';
import path from 'path';

import {
  parseWikiPage,
  serializeWikiPage,
  WikiClaim,
  WikiPageFrontmatter,
} from '../src/wiki/markdown.js';
import { atomicWriteFile } from '../src/wiki/fs-util.js';

const VAULT =
  process.argv[2] ?? 'groups/telegram_wiki-inbox/wiki';

interface PersonMerge {
  from: string; // short-name basename (stub, will be deleted)
  to: string; // canonical long-name basename (survivor)
}

const PEOPLE_MERGES: PersonMerge[] = [
  { from: 'dom', to: 'dom-ingleston' },
  { from: 'nata', to: 'nata-luyindula' },
  { from: 'maurizio', to: 'maurizio-faerber' },
];

const TOOL_MOVES = ['gmail', 'gemini', 'sonnet', 'm1'];

// =============================================================================
// Phase 1: dedupe people
// =============================================================================

interface MergeReport {
  merged: string[];
  claimsAdded: number;
  sourceIdsAdded: number;
  linksRewritten: number;
  filesTouched: number;
}

function dedupePeople(): MergeReport {
  const report: MergeReport = {
    merged: [],
    claimsAdded: 0,
    sourceIdsAdded: 0,
    linksRewritten: 0,
    filesTouched: 0,
  };

  for (const { from, to } of PEOPLE_MERGES) {
    const fromPath = path.join(VAULT, 'people', `${from}.md`);
    const toPath = path.join(VAULT, 'people', `${to}.md`);

    if (!fs.existsSync(fromPath)) {
      console.log(`  skip: ${from}.md already gone`);
      continue;
    }
    if (!fs.existsSync(toPath)) {
      console.log(`  skip: canonical ${to}.md missing`);
      continue;
    }

    const fromRaw = fs.readFileSync(fromPath, 'utf-8');
    const toRaw = fs.readFileSync(toPath, 'utf-8');
    const fromParsed = parseWikiPage(fromRaw);
    const toParsed = parseWikiPage(toRaw);

    // Merge claims by id. Dedupe against existing claim ids on the
    // survivor so re-running this script never produces duplicates.
    const existingIds = new Set(
      (toParsed.frontmatter.claims ?? []).map((c) => c.id).filter(Boolean),
    );
    const extraClaims: WikiClaim[] = [];
    for (const claim of fromParsed.frontmatter.claims ?? []) {
      if (claim.id && existingIds.has(claim.id)) continue;
      extraClaims.push(claim);
      if (claim.id) existingIds.add(claim.id);
    }
    const mergedClaims = [
      ...(toParsed.frontmatter.claims ?? []),
      ...extraClaims,
    ];

    // Merge sourceIds, union, stable order.
    const existingSources = new Set(toParsed.frontmatter.sourceIds ?? []);
    const mergedSources = [...(toParsed.frontmatter.sourceIds ?? [])];
    for (const s of fromParsed.frontmatter.sourceIds ?? []) {
      if (existingSources.has(s)) continue;
      mergedSources.push(s);
      existingSources.add(s);
    }

    // Merge tags (if present).
    const existingTags = new Set(
      ((toParsed.frontmatter.tags as string[]) ?? []).map((t) => t),
    );
    const mergedTags = [...((toParsed.frontmatter.tags as string[]) ?? [])];
    for (const t of (fromParsed.frontmatter.tags as string[]) ?? []) {
      if (existingTags.has(t)) continue;
      mergedTags.push(t);
      existingTags.add(t);
    }

    // If the stub page has unique body prose the canonical doesn't
    // already cover, preserve it under an `## Additional context`
    // section. Skip managed blocks and auto-stub header boilerplate.
    const stubUnique = extractUniqueProse(fromParsed.body);
    let mergedBody = toParsed.body;
    if (
      stubUnique.length > 0 &&
      !toParsed.body.includes('## Additional context')
    ) {
      mergedBody = appendSectionBeforeManagedBlocks(
        toParsed.body,
        '## Additional context\n\n' +
          `_Merged from ${from}.md on 2026-04-11._\n\n` +
          stubUnique,
      );
    }

    const nextFm: WikiPageFrontmatter = {
      ...toParsed.frontmatter,
      claims: mergedClaims,
      sourceIds: mergedSources,
    };
    if (mergedTags.length > 0) {
      nextFm.tags = mergedTags;
    }

    atomicWriteFile(toPath, serializeWikiPage(nextFm, mergedBody));
    fs.unlinkSync(fromPath);

    report.merged.push(`${from} → ${to}`);
    report.claimsAdded += extraClaims.length;
    report.sourceIdsAdded += mergedSources.length - (toParsed.frontmatter.sourceIds?.length ?? 0);
    report.filesTouched += 2; // survivor write + stub delete
  }

  // Rewrite every `[[from]]` wikilink across the vault to
  // `[[to|from-title]]`. Handles the three forms:
  //
  //   [[dom]]            → [[dom-ingleston|Dom]]
  //   [[dom|Dom]]        → [[dom-ingleston|Dom]]
  //   [[dom|something]]  → [[dom-ingleston|something]]
  //
  // Negative-lookahead-style pattern prevents matching
  // `[[dom-ingleston]]`: after `dom` we demand `]` or `|` immediately.
  const allFiles: string[] = [];
  walkDir(VAULT, allFiles);

  for (const file of allFiles) {
    if (!file.endsWith('.md')) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    let newRaw = raw;
    for (const { from, to } of PEOPLE_MERGES) {
      const re = new RegExp(
        `\\[\\[${escapeRe(from)}(\\|[^\\]]*)?\\]\\]`,
        'g',
      );
      newRaw = newRaw.replace(re, (_m, alias) => {
        const label = alias ? alias.slice(1) : capitaliseFirstWord(from);
        return `[[${to}|${label}]]`;
      });
    }
    if (newRaw !== raw) {
      fs.writeFileSync(file, newRaw);
      report.linksRewritten++;
    }
  }

  return report;
}

function extractUniqueProse(body: string): string {
  // Drop managed blocks, stub boilerplate, and `## Observed mentions`
  // (the stub's synthetic section). Keep everything else verbatim.
  const lines = body.split('\n');
  const out: string[] = [];
  let inManaged = false;
  let inObservedSection = false;
  for (const line of lines) {
    if (/<!--\s*openclaw:/.test(line) && line.includes(':start')) {
      inManaged = true;
      continue;
    }
    if (/<!--\s*openclaw:/.test(line) && line.includes(':end')) {
      inManaged = false;
      continue;
    }
    if (inManaged) continue;
    if (/^## Observed mentions\s*$/.test(line)) {
      inObservedSection = true;
      continue;
    }
    if (inObservedSection && /^##\s/.test(line)) {
      inObservedSection = false;
    }
    if (inObservedSection) continue;
    if (/^_Auto-created by candidate-processor/.test(line)) continue;
    if (/^# /.test(line)) continue; // drop H1 (survivor already has one)
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function appendSectionBeforeManagedBlocks(body: string, section: string): string {
  // Insert the new section just before the first managed block. If no
  // managed blocks exist, append to the end.
  const markerIdx = body.search(/<!--\s*openclaw:wiki:[a-z-]+:start\s*-->/);
  if (markerIdx === -1) {
    return body.trimEnd() + '\n\n' + section + '\n';
  }
  const head = body.slice(0, markerIdx).trimEnd();
  const tail = body.slice(markerIdx);
  return head + '\n\n' + section + '\n\n' + tail;
}

function walkDir(dir: string, out: string[]): void {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name.startsWith('.')) continue;
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walkDir(p, out);
    else out.push(p);
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitaliseFirstWord(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// =============================================================================
// Phase 2: reclassify tool pages
// =============================================================================

interface MoveReport {
  moved: string[];
  skipped: string[];
}

function moveToolsToConcepts(): MoveReport {
  const report: MoveReport = { moved: [], skipped: [] };

  for (const basename of TOOL_MOVES) {
    const fromPath = path.join(VAULT, 'projects', `${basename}.md`);
    const toPath = path.join(VAULT, 'concepts', `${basename}.md`);

    if (!fs.existsSync(fromPath)) {
      report.skipped.push(`${basename} (not in projects/)`);
      continue;
    }
    if (fs.existsSync(toPath)) {
      report.skipped.push(`${basename} (already in concepts/)`);
      continue;
    }

    const raw = fs.readFileSync(fromPath, 'utf-8');
    const parsed = parseWikiPage(raw);

    const nextFm: WikiPageFrontmatter = {
      ...parsed.frontmatter,
      pageType: 'concept',
    };
    if (typeof nextFm.id === 'string' && nextFm.id.startsWith('project.')) {
      nextFm.id = 'concept.' + nextFm.id.slice('project.'.length);
    }

    atomicWriteFile(toPath, serializeWikiPage(nextFm, parsed.body));
    fs.unlinkSync(fromPath);
    report.moved.push(`${basename}: projects/ → concepts/`);
  }

  return report;
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  console.log(`Cleanup vault: ${VAULT}\n`);

  console.log('Phase 1: dedupe people');
  const mergeReport = dedupePeople();
  console.log(`  Merged:           ${mergeReport.merged.join(', ') || 'none'}`);
  console.log(`  Claims added:     ${mergeReport.claimsAdded}`);
  console.log(`  SourceIds added:  ${mergeReport.sourceIdsAdded}`);
  console.log(`  Wikilinks updated in ${mergeReport.linksRewritten} files`);
  console.log('');

  console.log('Phase 2: reclassify tool pages');
  const moveReport = moveToolsToConcepts();
  for (const m of moveReport.moved) console.log(`  ${m}`);
  for (const s of moveReport.skipped) console.log(`  skip: ${s}`);
}

main();
