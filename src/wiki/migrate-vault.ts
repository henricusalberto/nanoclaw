/**
 * One-shot vault migration to the Phase 3 MECE taxonomy.
 *
 * Walks every page in the vault, runs the resolver on it, and produces
 * a migration plan. Pages already in the "right" directory are untouched.
 * Pages in `entities/` or the root are typically the ones that move —
 * `entities/` splits into `people/`, `companies/`, and whatever else the
 * resolver decides.
 *
 * Dry-run by default. `--apply` executes the plan: snapshots a pre-move
 * backup to `.openclaw-wiki/migration-backup/`, moves files atomically,
 * rewrites the `id` + `pageType` frontmatter, and appends an audit line
 * to `.openclaw-wiki/migration-log.jsonl`.
 *
 * Wikilinks are NOT rewritten — our wikilinks resolve by basename (not
 * directory path) so moving a file between dirs doesn't break them.
 * Anyone using dir-qualified `[[entities/dom]]` form would need to edit
 * manually; current vault doesn't use that form.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { appendWikiLogEvent } from './log.js';
import { parseWikiPage, serializeWikiPage, WikiPageKind } from './markdown.js';
import { vaultPaths } from './paths.js';
import {
  ensureMeceDirectories,
  readResolverConfig,
  resolve as resolvePage,
  ResolverDecision,
} from './resolver.js';

export interface MigrationPlanEntry {
  currentPath: string; // vault-relative
  currentKind: WikiPageKind | undefined;
  currentId: string | undefined;
  newPath: string;
  newKind: WikiPageKind;
  newId: string;
  decision: ResolverDecision;
  willMove: boolean;
}

export interface MigrationPlan {
  vaultPath: string;
  entries: MigrationPlanEntry[];
  skippedCount: number;
  movingCount: number;
}

export interface MigrationResult {
  plan: MigrationPlan;
  applied: boolean;
  movedCount: number;
  errors: { path: string; message: string }[];
  backupDir?: string;
  durationMs: number;
}

/**
 * Directories the migration walks. Deliberately includes `entities/`
 * and the vault root (via empty string) but NOT `sources/` — source
 * pages come from the bridge, moving them would desync bridge-state.
 */
const WALKABLE_DIRS = [
  '', // vault root (loose files like inbox.md)
  'entities',
  'concepts',
  'syntheses',
  'originals',
  'people',
  'companies',
  'meetings',
  'deals',
  'projects',
  'ideas',
  'writing',
  'personal',
  'household',
  'inbox',
];

// Files at the vault root that must never be migrated — these are
// human-authored indexes and conventions, not content pages.
const ROOT_PROTECTED = new Set([
  'index.md',
  'log.md',
  'WIKI.md',
  'AGENTS.md',
  'README.md',
  'RESOLVER.md',
]);

// `index.md` inside any subdirectory is compile-generated; never migrate.
function isProtectedFile(relPath: string): boolean {
  if (path.basename(relPath) === 'index.md') return true;
  const dir = path.dirname(relPath);
  if (dir === '.' && ROOT_PROTECTED.has(path.basename(relPath))) return true;
  return false;
}

/**
 * Walk the vault and build a migration plan. No I/O beyond reads — the
 * plan can be printed, reviewed, and re-computed safely any number of
 * times.
 */
export function buildMigrationPlan(vaultPath: string): MigrationPlan {
  const config = readResolverConfig(vaultPath);
  const entries: MigrationPlanEntry[] = [];

  for (const dir of WALKABLE_DIRS) {
    const abs = path.join(vaultPath, dir);
    if (!fs.existsSync(abs)) continue;
    const names = fs.readdirSync(abs);
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const relPath = dir ? path.join(dir, name) : name;
      if (isProtectedFile(relPath)) continue;
      const absFile = path.join(vaultPath, relPath);
      if (!fs.statSync(absFile).isFile()) continue;

      let parsed;
      try {
        parsed = parseWikiPage(fs.readFileSync(absFile, 'utf-8'));
      } catch {
        continue; // malformed frontmatter — skip
      }

      const title = String(
        parsed.frontmatter.title ?? name.replace(/\.md$/, ''),
      );
      const currentKind = parsed.frontmatter.pageType;
      const currentId =
        typeof parsed.frontmatter.id === 'string'
          ? parsed.frontmatter.id
          : undefined;

      // Only ask the resolver to re-classify when the current page is
      // generic `entity` or has no pageType at all. Pages already tagged
      // with a MECE kind stay put (we trust explicit intent).
      const shouldReclassify =
        !currentKind || currentKind === 'entity' || dir === '';
      const decision = shouldReclassify
        ? resolvePage({ title, pageType: undefined }, config)
        : resolvePage({ title, pageType: currentKind }, config);

      const currentDir = dir;
      const newDir = decision.directory;
      const newKind = decision.kind;

      // Key invariant: the migration only changes a page's DIRECTORY
      // (i.e., its taxonomy bucket). It never renames the file based on
      // title length — that would be wholesale churn for zero benefit.
      // Preserve the existing basename when the page stays in place,
      // and also when it moves: moving `entities/dom-ingleston.md` →
      // `people/dom-ingleston.md` keeps the slug intact so wikilinks
      // using `[[dom-ingleston]]` continue to resolve.
      const currentBasename = name;
      const willMove = newDir !== currentDir;
      const newBasename = currentBasename;
      const newPath = willMove ? path.join(newDir, newBasename) : relPath;
      const newId = willMove
        ? buildPageId(newKind, newBasename)
        : (currentId ?? buildPageId(newKind, newBasename));

      entries.push({
        currentPath: relPath,
        currentKind,
        currentId,
        newPath,
        newKind,
        newId,
        decision,
        willMove,
      });
    }
  }

  return {
    vaultPath,
    entries,
    skippedCount: entries.filter((e) => !e.willMove).length,
    movingCount: entries.filter((e) => e.willMove).length,
  };
}

/**
 * Execute the plan. Snapshots every moving page to the backup dir
 * first, then moves the file + rewrites frontmatter.id/pageType. Uses
 * atomicWriteFile so a crash mid-write can't corrupt the page.
 */
export function applyMigrationPlan(
  plan: MigrationPlan,
): Omit<MigrationResult, 'plan'> {
  const startedAt = Date.now();
  const errors: { path: string; message: string }[] = [];
  let movedCount = 0;

  ensureMeceDirectories(plan.vaultPath);

  const backupDir = path.join(
    vaultPaths(plan.vaultPath).stateDir,
    'migration-backup',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  fs.mkdirSync(backupDir, { recursive: true });

  const auditLines: string[] = [];

  for (const entry of plan.entries) {
    if (!entry.willMove) continue;

    const absOld = path.join(plan.vaultPath, entry.currentPath);
    const absNew = path.join(plan.vaultPath, entry.newPath);
    const absBackup = path.join(backupDir, entry.currentPath);

    try {
      // Refuse to clobber: if a page already exists at the target,
      // flag it and skip rather than silently overwrite.
      if (fs.existsSync(absNew)) {
        errors.push({
          path: entry.currentPath,
          message: `target already exists: ${entry.newPath}`,
        });
        continue;
      }

      // Backup first.
      fs.mkdirSync(path.dirname(absBackup), { recursive: true });
      fs.copyFileSync(absOld, absBackup);

      // Rewrite frontmatter: pageType + id update reflects the new kind.
      const parsed = parseWikiPage(fs.readFileSync(absOld, 'utf-8'));
      parsed.frontmatter.pageType = entry.newKind;
      parsed.frontmatter.id = entry.newId;
      // Preserve existing updatedAt — migration is not a content change.
      const serialized = serializeWikiPage(parsed.frontmatter, parsed.body);

      fs.mkdirSync(path.dirname(absNew), { recursive: true });
      atomicWriteFile(absNew, serialized);
      fs.rmSync(absOld);

      movedCount++;
      auditLines.push(
        JSON.stringify({
          ts: new Date().toISOString(),
          from: entry.currentPath,
          to: entry.newPath,
          oldKind: entry.currentKind ?? null,
          newKind: entry.newKind,
          oldId: entry.currentId ?? null,
          newId: entry.newId,
          rule: entry.decision.ruleName,
          confidence: entry.decision.confidence,
        }),
      );
    } catch (err) {
      errors.push({
        path: entry.currentPath,
        message: (err as Error).message,
      });
    }
  }

  // Append all audit lines at once — cheap and keeps the log readable.
  if (auditLines.length > 0) {
    const logPath = path.join(
      vaultPaths(plan.vaultPath).stateDir,
      'migration-log.jsonl',
    );
    fs.appendFileSync(logPath, auditLines.join('\n') + '\n');
  }

  if (movedCount > 0) {
    appendWikiLogEvent(plan.vaultPath, 'migrate-vault', {
      movedCount,
      errorCount: errors.length,
      backupDir,
    });
  }

  return {
    applied: true,
    movedCount,
    errors,
    backupDir,
    durationMs: Date.now() - startedAt,
  };
}

function buildPageId(kind: WikiPageKind, basename: string): string {
  const slug = basename.replace(/\.md$/, '');
  return `${kind}.${slug}`;
}
