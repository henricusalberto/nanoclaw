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
import { collectVaultPages } from './vault-walk.js';

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

// Human-authored top-level files the migration must never touch.
// `index.md` across any subdirectory is compile-generated and also
// filtered out by the shared walker.
const ROOT_PROTECTED = new Set([
  'index.md',
  'log.md',
  'WIKI.md',
  'AGENTS.md',
  'README.md',
  'RESOLVER.md',
  '_ingest-plan.md',
]);

/**
 * Walk the vault and build a migration plan. No I/O beyond reads — the
 * plan can be printed, reviewed, and re-computed safely any number of
 * times. Sources/ is intentionally excluded: source pages are owned by
 * the bridge and moving them would desync bridge-state.
 */
export function buildMigrationPlan(vaultPath: string): MigrationPlan {
  const config = readResolverConfig(vaultPath);
  const entries: MigrationPlanEntry[] = [];

  // Known subdirectories: the shared walker handles these, but we need
  // to skip `source` pages (owned by the bridge).
  const pages = collectVaultPages(vaultPath, { excludeKinds: ['source'] });
  for (const page of pages) {
    entries.push(
      planEntryFor({
        vaultPath,
        relPath: page.relativePath,
        dir: page.dir,
        name: path.basename(page.relativePath),
        title: String(
          page.frontmatter.title ?? path.basename(page.relativePath, '.md'),
        ),
        currentKind: page.kind,
        currentId:
          typeof page.frontmatter.id === 'string'
            ? page.frontmatter.id
            : undefined,
        config,
      }),
    );
  }

  // Vault root: loose files like `inbox.md` or hand-dropped ingest
  // notes. The shared walker doesn't cover the root, so we enumerate
  // it here and route everything that isn't protected through the
  // resolver.
  if (fs.existsSync(vaultPath)) {
    for (const name of fs.readdirSync(vaultPath)) {
      if (!name.endsWith('.md')) continue;
      if (ROOT_PROTECTED.has(name)) continue;
      const absFile = path.join(vaultPath, name);
      if (!fs.statSync(absFile).isFile()) continue;
      let parsed;
      try {
        parsed = parseWikiPage(fs.readFileSync(absFile, 'utf-8'));
      } catch {
        continue;
      }
      entries.push(
        planEntryFor({
          vaultPath,
          relPath: name,
          dir: '',
          name,
          title: String(parsed.frontmatter.title ?? name.replace(/\.md$/, '')),
          currentKind: parsed.frontmatter.pageType,
          currentId:
            typeof parsed.frontmatter.id === 'string'
              ? parsed.frontmatter.id
              : undefined,
          config,
        }),
      );
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
 * Single-entry planner. Pulled out of the loop so both the subtree
 * walk and the root-file walk share the same resolver + move logic.
 */
function planEntryFor(params: {
  vaultPath: string;
  relPath: string;
  dir: string;
  name: string;
  title: string;
  currentKind: WikiPageKind | undefined;
  currentId: string | undefined;
  config: ReturnType<typeof readResolverConfig>;
}): MigrationPlanEntry {
  // Re-classify when the page is generic `entity` or untyped, or when
  // it's a loose root file. Otherwise trust the explicit pageType.
  const shouldReclassify =
    !params.currentKind || params.currentKind === 'entity' || params.dir === '';
  const decision = shouldReclassify
    ? resolvePage({ title: params.title, pageType: undefined }, params.config)
    : resolvePage(
        { title: params.title, pageType: params.currentKind },
        params.config,
      );

  const newDir = decision.directory;
  const newKind = decision.kind;

  // Invariant: the migration only changes a page's directory. It never
  // renames based on title length — that would be wholesale churn for
  // zero benefit. The slug stays intact so `[[basename]]` wikilinks
  // keep resolving after the move.
  const willMove = newDir !== params.dir;
  const newBasename = params.name;
  const newPath = willMove ? path.join(newDir, newBasename) : params.relPath;
  const newId = willMove
    ? buildPageId(newKind, newBasename)
    : (params.currentId ?? buildPageId(newKind, newBasename));

  return {
    currentPath: params.relPath,
    currentKind: params.currentKind,
    currentId: params.currentId,
    newPath,
    newKind,
    newId,
    decision,
    willMove,
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
