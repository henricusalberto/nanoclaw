/**
 * Wiki CLI. Defaults to the wiki-inbox vault when no path is given.
 *
 *   npx tsx src/wiki/cli.ts bridge              # sync memory files into sources/
 *   npx tsx src/wiki/cli.ts compile             # related blocks + caches
 *   npx tsx src/wiki/cli.ts lint                # health checks
 *   npx tsx src/wiki/cli.ts autofix             # dry-run auto-repair
 *   npx tsx src/wiki/cli.ts autofix --apply     # apply auto-repair
 */

import path from 'path';

import { runAutofix } from './autofix.js';
import { syncWikiBridge } from './bridge.js';
import { compileWiki } from './compile.js';
import { runEntityScan } from './entity-scan.js';
import { lintWiki } from './lint.js';

const DEFAULT_VAULT = 'groups/telegram_wiki-inbox/wiki';

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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.slice(1).filter((a) => !a.startsWith('--'));
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
      console.log(`  Quiet-hours deferred:  ${result.windowsSkippedQuietHours}`);
      console.log(`  Budget deferred:       ${result.windowsSkippedBudget}`);
      console.log(`  Entities extracted:    ${result.entitiesExtracted}`);
      console.log(`  Originals extracted:   ${result.originalsExtracted}`);
      console.log(`  LLM calls:             ${result.llmCalls}`);
      console.log(`  Estimated USD spent:   $${result.usdSpent.toFixed(4)}`);
      console.log(`  Duration:              ${result.durationMs}ms`);
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
      console.log(
        '  entity-scan [--morning]',
      );
      console.log(
        '                    Process conversation-window entity queue',
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
