/**
 * Wiki CLI. Defaults to the wiki-inbox vault when no path is given.
 *
 *   npx tsx src/wiki/cli.ts bridge   # sync memory files into sources/
 *   npx tsx src/wiki/cli.ts compile  # related blocks + caches
 *   npx tsx src/wiki/cli.ts lint     # health checks
 */

import path from 'path';

import { syncWikiBridge } from './bridge.js';
import { compileWiki } from './compile.js';
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
  const vaultArg = args[1];
  const vaultPath = path.resolve(vaultArg || DEFAULT_VAULT);

  switch (cmd) {
    case 'bridge':
      await cmdBridge(vaultPath);
      return;
    case 'compile': {
      console.log(`Compiling wiki: ${vaultPath}`);
      const result = await compileWiki(vaultPath);
      console.log('\nCompile complete:');
      console.log(`  Pages walked:        ${result.pageCount}`);
      console.log(`  Related rewritten:   ${result.rewrittenCount}`);
      console.log(`  Indexes refreshed:   ${result.indexesRefreshed}`);
      console.log(`  Digest pages:        ${result.digestPageCount}`);
      console.log(`  Digest claims:       ${result.digestClaimCount}`);
      console.log(`  Duration:            ${result.durationMs}ms`);
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
      console.log('  bridge   Sync memory files into wiki sources/');
      console.log('  compile  Recompute related blocks + agent-digest cache');
      console.log('  lint     Run structural health checks');
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
