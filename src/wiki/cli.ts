/**
 * Wiki CLI. Defaults to the wiki-inbox vault when no path is given.
 *
 *   npx tsx src/wiki/cli.ts bridge              # sync memory files into sources/
 *   npx tsx src/wiki/cli.ts compile             # related blocks + caches
 *   npx tsx src/wiki/cli.ts lint                # health checks
 *   npx tsx src/wiki/cli.ts autofix             # dry-run auto-repair
 *   npx tsx src/wiki/cli.ts autofix --apply     # apply auto-repair
 */

import fs from 'fs';
import path from 'path';

import { runAutofix } from './autofix.js';
import { syncWikiBridge } from './bridge.js';
import { compileWiki } from './compile.js';
import { runEntityScan } from './entity-scan.js';
import { ExtractorInput } from './extractors/base.js';
import { getDefaultRegistry } from './extractors/registry.js';
import { lintWiki } from './lint.js';
import { serializeWikiPage, WikiPageFrontmatter } from './markdown.js';
import { applyMigrationPlan, buildMigrationPlan } from './migrate-vault.js';
import { vaultPaths } from './paths.js';
import { resolveForVault } from './resolver.js';

const DEFAULT_VAULT = 'groups/telegram_wiki-inbox/wiki';

/**
 * Read the value following a `--flag value` pair. Returns undefined if
 * the flag isn't present. Used by `extract` to keep its interface aligned
 * with standard CLI conventions instead of introducing a flag-value parser.
 */
function getFlagValue(
  flags: string[],
  args: string[],
  flagName: string,
): string | undefined {
  const idx = args.indexOf(flagName);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const next = args[idx + 1];
  if (next.startsWith('--')) return undefined;
  return next;
}

function sanitizeSlug(title: string, fallback: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

async function cmdBridge(vaultPath: string): Promise<void> {
  const repoRoot = process.cwd();
  console.log(`Syncing wiki bridge: ${vaultPath}`);
  const result = await syncWikiBridge(vaultPath, repoRoot);
  console.log('\nBridge sync complete:');
  console.log(`  Imported (new):   ${result.importedCount}`);
  console.log(`  Updated:          ${result.updatedCount}`);
  console.log(`  Skipped (clean):  ${result.skippedCount}`);
  console.log(`  Removed (pruned): ${result.removedCount}`);
  console.log(`  Errors:           ${result.errorCount}`);
  console.log(`  Duration:         ${result.durationMs}ms`);
  if (result.changedSourceIds.length > 0) {
    console.log(
      `\nPending ingest marker dropped at .openclaw-wiki/pending-ingest.json`,
    );
    console.log(`  ${result.changedSourceIds.length} source pages changed`);
    if (result.changedSourceIds.length <= 20) {
      for (const id of result.changedSourceIds) {
        console.log(`    - ${id}`);
      }
    }
  }
}

// Flags that consume the next argv as their value. When we split args
// into positional vs flag sets, the value immediately following one of
// these must NOT be treated as a positional or vault-path.
const VALUE_FLAGS = new Set([
  '--url',
  '--file',
  '--bookmark-id',
  '--title',
  '--type',
  '--hint',
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = args.filter((a) => a.startsWith('--'));
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++; // skip the flag's value
      continue;
    }
    positional.push(a);
  }
  const vaultArg = positional[0];
  const vaultPath = path.resolve(vaultArg || DEFAULT_VAULT);
  const apply = flags.includes('--apply');
  const skipQuietHours = flags.includes('--morning');

  switch (cmd) {
    case 'bridge':
      await cmdBridge(vaultPath);
      return;
    case 'entity-scan': {
      console.log(
        `Entity scan (${skipQuietHours ? 'morning flush' : 'windowed'}): ${vaultPath}`,
      );
      const result = await runEntityScan(vaultPath, { skipQuietHours });
      console.log('\nEntity scan complete:');
      console.log(`  Windows processed:     ${result.windowsProcessed}`);
      console.log(
        `  Rejected (pre-filter): ${result.windowsRejectedByPrefilter}`,
      );
      console.log(
        `  Quiet-hours deferred:  ${result.windowsSkippedQuietHours}`,
      );
      console.log(`  Budget deferred:       ${result.windowsSkippedBudget}`);
      console.log(`  Entities extracted:    ${result.entitiesExtracted}`);
      console.log(`  Originals extracted:   ${result.originalsExtracted}`);
      console.log(`  LLM calls:             ${result.llmCalls}`);
      console.log(`  Estimated USD spent:   $${result.usdSpent.toFixed(4)}`);
      console.log(`  Duration:              ${result.durationMs}ms`);
      return;
    }
    case 'resolve': {
      const title = getFlagValue(flags, args, '--title');
      const type = getFlagValue(flags, args, '--type');
      const hint = getFlagValue(flags, args, '--hint');
      if (!title) {
        console.error('resolve requires --title <string>');
        process.exit(2);
      }
      const decision = resolveForVault(vaultPath, {
        title,
        pageType: type,
        hint,
      });
      console.log(JSON.stringify(decision, null, 2));
      return;
    }
    case 'migrate-vault': {
      console.log(
        `Building migration plan for vault: ${vaultPath} (${apply ? 'APPLY' : 'DRY RUN'})`,
      );
      const plan = buildMigrationPlan(vaultPath);
      console.log(`\nPlan: ${plan.entries.length} pages scanned`);
      console.log(`  Moving:  ${plan.movingCount}`);
      console.log(`  Staying: ${plan.skippedCount}`);
      if (plan.movingCount > 0) {
        console.log('\nProposed moves:');
        for (const e of plan.entries.filter((x) => x.willMove).slice(0, 80)) {
          console.log(
            `  ${e.currentPath}  →  ${e.newPath}  [${e.decision.ruleName} conf=${e.decision.confidence}]`,
          );
        }
        if (plan.movingCount > 80) {
          console.log(`  ... and ${plan.movingCount - 80} more`);
        }
      }
      if (!apply) {
        console.log(
          '\n[DRY RUN] Review the plan, then re-run with --apply to execute.',
        );
        return;
      }
      console.log('\nApplying migration...');
      const result = applyMigrationPlan(plan);
      console.log('\nMigration complete:');
      console.log(`  Moved:    ${result.movedCount}`);
      console.log(`  Errors:   ${result.errors.length}`);
      console.log(`  Backup:   ${result.backupDir}`);
      console.log(`  Duration: ${result.durationMs}ms`);
      if (result.errors.length > 0) {
        console.log('\nErrors:');
        for (const err of result.errors) {
          console.log(`  ${err.path}: ${err.message}`);
        }
      }
      return;
    }
    case 'extract': {
      const urlFlag = getFlagValue(flags, args, '--url');
      const fileFlag = getFlagValue(flags, args, '--file');
      const bookmarkFlag = getFlagValue(flags, args, '--bookmark-id');
      if (!urlFlag && !fileFlag && !bookmarkFlag) {
        console.error(
          'extract requires one of --url <url>, --file <path>, --bookmark-id <id>',
        );
        process.exit(2);
      }
      let input: ExtractorInput;
      if (urlFlag) input = { kind: 'url', url: urlFlag };
      else if (fileFlag) input = { kind: 'file', path: path.resolve(fileFlag) };
      else input = { kind: 'bookmark-id', bookmarkId: bookmarkFlag! };

      console.log(
        `Extracting ${input.kind}: ${urlFlag ?? fileFlag ?? bookmarkFlag}`,
      );
      const registry = getDefaultRegistry();
      const content = await registry.extract(input);
      console.log(
        `  Extractor: ${content.extractorName}@${content.extractorVersion}`,
      );
      console.log(`  Title:     ${content.title}`);
      console.log(`  Mime:      ${content.mimeType}`);
      console.log(`  Body size: ${content.body.length} chars`);

      // Write a source page into the default vault under sources/extract/
      const outDir = path.join(vaultPath, 'sources', 'extract');
      fs.mkdirSync(outDir, { recursive: true });
      const slug = sanitizeSlug(content.title, content.extractorName);
      const pageRel = path.join('sources', 'extract', `${slug}.md`);
      const pageAbs = path.join(vaultPath, pageRel);
      const frontmatter: WikiPageFrontmatter = {
        id: `source.extract.${slug}`,
        pageType: 'source',
        title: content.title,
        sourceIds: [],
        claims: [],
        contradictions: [],
        questions: [],
        confidence: 0.7,
        status: 'active',
        updatedAt: content.extractedAt,
        sourceType: 'extracted-asset',
        ingestedAt: content.extractedAt,
        extractorName: content.extractorName,
        extractorVersion: content.extractorVersion,
        extractedAt: content.extractedAt,
        extractorMimeType: content.mimeType,
        extractorMetadata: content.metadata,
        ...(content.originalUrl && { originalUrl: content.originalUrl }),
        ...(content.originalPath && { originalPath: content.originalPath }),
      };
      const body = [
        '## Source\n',
        '| Field | Value |',
        '|---|---|',
        `| Extractor | \`${content.extractorName}@${content.extractorVersion}\` |`,
        `| Extracted at | ${content.extractedAt} |`,
        `| Mime type | \`${content.mimeType}\` |`,
        `| Original | ${content.originalUrl ?? content.originalPath ?? '(none)'} |`,
        '',
        '## Content\n',
        content.body.trim(),
        '',
      ].join('\n');
      fs.writeFileSync(pageAbs, serializeWikiPage(frontmatter, body));
      console.log(`\nWrote source page: ${pageRel}`);
      return;
    }
    case 'autofix': {
      console.log(
        `Autofixing wiki (${apply ? 'APPLY' : 'DRY RUN'}): ${vaultPath}`,
      );
      const result = await runAutofix(vaultPath, { apply });
      console.log('\nAutofix complete:');
      console.log(`  Pages scanned:             ${result.pagesScanned}`);
      console.log(
        `  Attributions backfilled:   ${result.attributionsBackfilled}`,
      );
      console.log(`  Mentions wrapped:          ${result.mentionsWrapped}`);
      console.log(`  Pages written:             ${result.pagesWritten}`);
      console.log(`  Duration:                  ${result.durationMs}ms`);
      if (result.changes.length > 0) {
        console.log('\nChanges by page:');
        for (const { pagePath, changes } of result.changes.slice(0, 30)) {
          console.log(`  ${pagePath}`);
          for (const c of changes.slice(0, 3)) {
            console.log(`    - ${c}`);
          }
          if (changes.length > 3) {
            console.log(`    ... and ${changes.length - 3} more`);
          }
        }
        if (result.changes.length > 30) {
          console.log(`  ... and ${result.changes.length - 30} more pages`);
        }
      }
      if (
        !apply &&
        (result.attributionsBackfilled > 0 || result.mentionsWrapped > 0)
      ) {
        console.log(
          '\n[DRY RUN] No files modified. Re-run with --apply to write.',
        );
      }
      return;
    }
    case 'compile': {
      console.log(`Compiling wiki: ${vaultPath}`);
      const result = await compileWiki(vaultPath);
      console.log('\nCompile complete:');
      console.log(`  Pages walked:         ${result.pageCount}`);
      console.log(`  Related rewritten:    ${result.rewrittenCount}`);
      console.log(`  Indexes refreshed:    ${result.indexesRefreshed}`);
      console.log(`  Digest pages:         ${result.digestPageCount}`);
      console.log(`  Digest claims:        ${result.digestClaimCount}`);
      console.log(
        `  Lint issues:          ${result.lintIssueCount} (${result.lintErrorCount} err / ${result.lintWarningCount} warn)`,
      );
      console.log(`  Missing attributions: ${result.missingAttributions}`);
      console.log(`  Unlinked mentions:    ${result.unlinkedMentions}`);
      console.log(`  Duration:             ${result.durationMs}ms`);
      return;
    }
    case 'lint': {
      console.log(`Linting wiki: ${vaultPath}`);
      const result = await lintWiki(vaultPath);
      console.log('\nLint complete:');
      console.log(`  Pages walked:     ${result.pageCount}`);
      console.log(`  Total issues:     ${result.issueCount}`);
      console.log(`  Errors:           ${result.bySeverity.error}`);
      console.log(`  Warnings:         ${result.bySeverity.warning}`);
      console.log(`  Duration:         ${result.durationMs}ms`);
      console.log(`\nReport: reports/lint.md`);
      if (result.issueCount > 0) {
        console.log('\nTop issue types:');
        const sorted = Object.entries(result.byCode).sort(
          (a, b) => b[1] - a[1],
        );
        for (const [code, count] of sorted.slice(0, 5)) {
          if (count === 0) continue;
          console.log(`  ${code}: ${count}`);
        }
      }
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log('NanoClaw wiki CLI');
      console.log('');
      console.log('Usage:');
      console.log('  npx tsx src/wiki/cli.ts <command> [vault-path]');
      console.log('');
      console.log('Commands:');
      console.log('  bridge            Sync memory files into wiki sources/');
      console.log(
        '  compile           Recompute related blocks + agent-digest cache',
      );
      console.log('  lint              Run structural health checks');
      console.log(
        '  autofix [--apply] Auto-repair lint issues (dry-run by default)',
      );
      console.log('  entity-scan [--morning]');
      console.log(
        '                    Process conversation-window entity queue',
      );
      console.log('  extract --url <url> | --file <path> | --bookmark-id <id>');
      console.log(
        '                    Run extractor registry on one input, write source page',
      );
      console.log('  resolve --title <s> [--type <kind>] [--hint <s>]');
      console.log(
        '                    Print the directory + kind the resolver would assign',
      );
      console.log('  migrate-vault [--apply]');
      console.log(
        '                    Run Phase 3 MECE migration (dry-run by default)',
      );
      console.log('');
      console.log('Default vault: ' + DEFAULT_VAULT);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
