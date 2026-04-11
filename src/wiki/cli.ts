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

import { applyProposal } from './apply-proposal.js';
import { runAutofix } from './autofix.js';
import { runBackfillHubs } from './backfill-hubs.js';
import { syncWikiBridge } from './bridge.js';
import { classifyBookmarks } from './classify-bookmarks.js';
import { processCandidates } from './candidate-processor.js';
import { compileWiki } from './compile.js';
import { DEFAULT_DREAM_BUDGET_CONFIG } from './dream-budget.js';
import { runDreamCycle } from './dream-cycle.js';
import { enrichPageManually } from './enrichment.js';
import { backfillEntityScanFromSources, runEntityScan } from './entity-scan.js';
import {
  computeBacklinks,
  neighbors,
  readGraphIndex,
  shortestPath,
  traverse,
} from './graph.js';
import { installWikiHooks } from './install-hooks.js';
import { ExtractorInput } from './extractors/base.js';
import { getDefaultRegistry } from './extractors/registry.js';
import { lintWiki } from './lint.js';
import { serializeWikiPage, WikiPageFrontmatter } from './markdown.js';
import { applyMigrationPlan, buildMigrationPlan } from './migrate-vault.js';
import { invokeOperation, listOperations } from './operations.js';
import { vaultPaths } from './paths.js';
import { runQuery } from './query.js';
import { resolveForVault } from './resolver.js';
import { resolveSlug } from './slug-resolver.js';
import {
  createStubsFromCandidates,
  findStubCandidates,
} from './stub-creator.js';
import { collectVaultPages } from './vault-walk.js';
import {
  diffVersions,
  listVersions,
  readVersion,
  revertToVersion,
} from './versions.js';
import { classifyAll, readMetricsHistory } from './volume-checker.js';

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
  '--page',
  '--ts',
  '--from',
  '--to',
  '--depth',
  '--name',
  '--min-mentions',
  '--input',
  '--tier',
  '--question',
  '--limit',
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
  // Some commands take a subcommand as their first positional rather
  // than a vault path. For those, treat positional[0] as the subcommand
  // and skip the vault arg entirely (always uses the default vault).
  const SUBCOMMAND_HOSTS = new Set([
    'graph',
    'slug',
    'volume',
    'op',
    'query',
    'apply-split',
  ]);
  const isSubcommandHost = SUBCOMMAND_HOSTS.has(cmd ?? '');
  const vaultArg = isSubcommandHost ? undefined : positional[0];
  const vaultPath = path.resolve(vaultArg || DEFAULT_VAULT);
  const apply = flags.includes('--apply');
  const skipQuietHours = flags.includes('--morning');

  // Phase 5: install the writeWikiPage version-snapshot hook so every
  // CLI invocation that mutates a page accumulates audit history.
  installWikiHooks({ vaultPath });

  switch (cmd) {
    case 'bridge':
      await cmdBridge(vaultPath);
      return;
    case 'entity-scan': {
      const backfillSources = flags.includes('--backfill-sources');
      if (backfillSources) {
        console.log(`Entity scan (backfill memory sources): ${vaultPath}`);
        const r = await backfillEntityScanFromSources(vaultPath);
        console.log('\nBackfill complete:');
        console.log(`  Pages processed:       ${r.windowsProcessed}`);
        console.log(`  Entities extracted:    ${r.entitiesExtracted}`);
        console.log(`  Originals extracted:   ${r.originalsExtracted}`);
        console.log(`  Budget-blocked:        ${r.windowsSkippedBudget}`);
        console.log(`  LLM calls:             ${r.llmCalls}`);
        console.log(`  Estimated USD spent:   $${r.usdSpent.toFixed(4)}`);
        console.log(`  Duration:              ${r.durationMs}ms`);
        return;
      }
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
    case 'stubs': {
      const minMentions = parseInt(
        getFlagValue(flags, args, '--min-mentions') ?? '3',
        10,
      );
      console.log(
        `Stub creator (dry-run=${apply ? 'no' : 'yes'}, minMentions=${minMentions}): ${vaultPath}`,
      );
      const candidates = findStubCandidates(vaultPath, { minMentions });
      console.log(`\n${candidates.length} candidates above threshold:`);
      for (const c of candidates.slice(0, 50)) {
        const flag = c.autoCreate ? '✓' : '?';
        console.log(
          `  ${flag} ${c.name.padEnd(40)} → ${c.directory}/${c.basename}.md  (${c.mentionCount} mentions)`,
        );
      }
      if (candidates.length > 50) {
        console.log(`  ... and ${candidates.length - 50} more`);
      }
      if (!apply) {
        const willCreate = candidates.filter((c) => c.autoCreate).length;
        console.log(
          `\n[DRY RUN] ${willCreate} pages would be created with --apply.`,
        );
        return;
      }
      const result = createStubsFromCandidates(vaultPath, candidates, {
        minMentions,
      });
      console.log(`\nStub creation complete:`);
      console.log(`  Pages written:         ${result.written}`);
      console.log(`  Skipped (low conf):    ${result.skippedLowConfidence}`);
      console.log(`  Skipped (existing):    ${result.skippedExisting}`);
      return;
    }
    case 'drain-candidates': {
      console.log(`Draining entity candidates: ${vaultPath}`);
      const result = await processCandidates(vaultPath);
      console.log('\nCandidate drain complete:');
      console.log(`  Scanned:            ${result.candidatesScanned}`);
      console.log(`  Stage 1 blocked:    ${result.blocked}`);
      console.log(`  Stage 1 merged:     ${result.merged}`);
      console.log(`  Stage 1 promoted:   ${result.promoted}`);
      console.log(`  Originals saved:    ${result.originalsSaved}`);
      console.log(`  Stage 2 merged:     ${result.llmMerged}`);
      console.log(`  Stage 2 promoted:   ${result.llmPromoted}`);
      console.log(`  Stage 2 discarded:  ${result.llmDiscarded}`);
      console.log(`  Sonnet calls:       ${result.llmCalls}`);
      console.log(`  Budget-blocked:     ${result.llmBudgetBlocked}`);
      console.log(`  Review queue size:  ${result.reviewQueueSize}`);
      console.log(`  Duration:           ${result.durationMs}ms`);
      return;
    }
    case 'dream': {
      console.log(`Dream cycle: ${vaultPath}`);
      const result = await runDreamCycle(vaultPath);
      console.log('\nDream cycle complete:');
      console.log(`  Pages scanned:         ${result.pagesScanned}`);
      console.log(`  Enrichment candidates: ${result.enrichment.candidates}`);
      console.log(`  Tier 0 applied:        ${result.enrichment.tier0Applied}`);
      console.log(
        `  Tier 1 written:        ${result.enrichment.tier1Written} (of ${result.enrichment.tier1Attempted})`,
      );
      console.log(
        `  Budget-blocked:        ${result.enrichment.budgetBlocked}`,
      );
      if (result.compile) {
        console.log(
          `  Lint issues:           ${result.compile.lintIssueCount}`,
        );
        console.log(
          `  Timeline rewrites:     ${result.compile.timelinePagesRewritten}`,
        );
      }
      console.log(`  Report:                ${result.reportPath}`);
      console.log(`  Duration:              ${result.durationMs}ms`);
      if (result.enrichment.errors.length > 0) {
        console.log(`\nErrors (${result.enrichment.errors.length}):`);
        for (const err of result.enrichment.errors.slice(0, 10)) {
          console.log(`  ${err.page}: ${err.message}`);
        }
      }
      return;
    }
    case 'enrich': {
      const slug = args.find(
        (a, i) => i > 0 && !a.startsWith('--') && args[i - 1] !== '--tier',
      );
      if (!slug) {
        console.error(
          'enrich requires <slug>, e.g. `wiki enrich recharge-brand --tier 2`',
        );
        process.exit(2);
      }
      const tierStr = getFlagValue(flags, args, '--tier') ?? '2';
      const tier = Number(tierStr);
      if (tier !== 1 && tier !== 2 && tier !== 3) {
        console.error('enrich --tier must be 1, 2, or 3');
        process.exit(2);
      }
      console.log(`Enriching ${slug} at tier ${tier}...`);
      const pages = collectVaultPages(vaultPath);
      const result = await enrichPageManually({
        vaultPath,
        slug,
        tier: tier as 1 | 2 | 3,
        pages,
        budget: DEFAULT_DREAM_BUDGET_CONFIG,
        now: new Date(),
      });
      if (result.budgetBlocked) {
        console.error(`Budget blocked: ${result.reason ?? 'unknown'}`);
        process.exit(3);
      }
      console.log(`Shadow proposal written: ${result.proposedPath}`);
      return;
    }
    case 'apply-proposal': {
      const slug = getFlagValue(flags, args, '--page') ?? positional[1];
      if (!slug) {
        console.error(
          'apply-proposal requires --page <slug> (or as second positional)',
        );
        process.exit(2);
      }
      const asJson = flags.includes('--json');
      const result = applyProposal({
        vaultPath,
        slug,
        dryRun: !apply,
      });
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exit(3);
        return;
      }
      if (!result.ok) {
        console.error(`apply-proposal: ${result.error}`);
        process.exit(3);
      }
      if (result.dryRun) {
        console.log(`[DRY RUN] Would apply proposal for: ${slug}`);
        console.log(`  Target:   ${result.targetPath}`);
        console.log(`  Proposal: ${result.proposedPath}`);
        console.log(
          `  New body: ${result.newBodyBytes} bytes, ${result.managedBlocksPreserved} managed blocks preserved`,
        );
        if (result.sections) {
          console.log(
            `  Dropped:  ${result.sections.claims} claims, ${result.sections.suggestedLinks} cross-links, ${result.sections.questions} questions, ${result.sections.contradictions} contradictions`,
          );
        }
        console.log('');
        console.log('--- new body preview ---');
        console.log(result.newBodyPreview);
        console.log('');
        console.log('Re-run with --apply to write the change.');
      } else {
        console.log(`Applied proposal for: ${slug}`);
        console.log(`  Target:   ${result.targetPath}`);
        console.log(`  Archived: ${result.archivedPath}`);
        console.log(
          `  Body:     ${result.newBodyBytes} bytes, ${result.managedBlocksPreserved} managed blocks preserved`,
        );
      }
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
    case 'history': {
      const slug = getFlagValue(flags, args, '--page') ?? positional[1];
      if (!slug) {
        console.error('history requires --page <slug> (or as positional)');
        process.exit(2);
      }
      const versions = listVersions(vaultPath, slug);
      if (versions.length === 0) {
        console.log(`No history for "${slug}"`);
        return;
      }
      console.log(`History for ${slug} (newest first):`);
      for (const v of versions) {
        console.log(
          `  ${v.ts}  ${v.isoTs}  ${v.writtenBy}${v.reason ? ` — ${v.reason}` : ''}`,
        );
      }
      return;
    }
    case 'diff': {
      const slug = getFlagValue(flags, args, '--page') ?? positional[1];
      const fromTs = getFlagValue(flags, args, '--from');
      const toTs = getFlagValue(flags, args, '--to');
      if (!slug || !fromTs || !toTs) {
        console.error('diff requires --page <slug> --from <ts> --to <ts>');
        process.exit(2);
      }
      const a = readVersion(vaultPath, slug, parseInt(fromTs, 10));
      const b = readVersion(vaultPath, slug, parseInt(toTs, 10));
      if (!a || !b) {
        console.error('one or both versions not found');
        process.exit(2);
      }
      console.log(diffVersions(a, b));
      return;
    }
    case 'revert': {
      const slug = getFlagValue(flags, args, '--page') ?? positional[1];
      const ts = getFlagValue(flags, args, '--ts');
      if (!slug || !ts) {
        console.error('revert requires --page <slug> --ts <ts>');
        process.exit(2);
      }
      // Resolve the live page path. We try the current basename across
      // every walked dir. Brittle but the migration script handles
      // moves; this is the simple-vault path.
      const pages = collectVaultPages(vaultPath);
      const target = pages.find((p) => p.basename === slug.toLowerCase());
      if (!target) {
        console.error(`live page for slug "${slug}" not found in vault`);
        process.exit(2);
      }
      const result = revertToVersion({
        vaultPath,
        pagePath: target.filePath,
        slug,
        ts: parseInt(ts, 10),
        writtenBy: 'cli-revert',
      });
      console.log(`Reverted ${slug} to ${result.restored.isoTs}`);
      console.log(`Pre-revert snapshot: ${result.preRevertSnapshot}`);
      return;
    }
    case 'graph': {
      // Subcommand: `wiki graph traverse --page X --depth N`
      const sub = positional[0];
      if (sub !== 'traverse' && sub !== 'backlinks' && sub !== 'path') {
        console.error('graph subcommand: traverse | backlinks | path');
        process.exit(2);
      }
      const graph = readGraphIndex(vaultPath);
      if (sub === 'traverse') {
        const slug = getFlagValue(flags, args, '--page');
        const depth = parseInt(getFlagValue(flags, args, '--depth') ?? '2', 10);
        if (!slug) {
          console.error('graph traverse requires --page <slug>');
          process.exit(2);
        }
        const r = traverse(graph, slug, { maxDepth: depth });
        for (const node of r) {
          console.log(`${'  '.repeat(node.depth)}${node.basename}`);
        }
        return;
      }
      if (sub === 'backlinks') {
        const slug = getFlagValue(flags, args, '--page');
        if (!slug) {
          console.error('graph backlinks requires --page <slug>');
          process.exit(2);
        }
        for (const b of computeBacklinks(graph, slug)) console.log(b);
        return;
      }
      if (sub === 'path') {
        const from = getFlagValue(flags, args, '--from');
        const to = getFlagValue(flags, args, '--to');
        if (!from || !to) {
          console.error('graph path requires --from <slug> --to <slug>');
          process.exit(2);
        }
        const p = shortestPath(graph, from, to);
        if (!p) {
          console.log(`(no path from ${from} to ${to})`);
        } else {
          console.log(p.join(' → '));
          // Surface neighbour count for color so the user can sanity-check.
          console.log(
            `(${p.length - 1} hops via ${neighbors(graph, from).length} first-degree neighbours)`,
          );
        }
        return;
      }
      return;
    }
    case 'slug': {
      // `wiki slug resolve --name "Dom Inglston"`
      const sub = positional[0];
      if (sub !== 'resolve') {
        console.error('slug subcommand: resolve');
        process.exit(2);
      }
      const name = getFlagValue(flags, args, '--name');
      if (!name) {
        console.error('slug resolve requires --name <string>');
        process.exit(2);
      }
      const pages = collectVaultPages(vaultPath).map((p) => ({
        basename: p.basename,
        title: p.frontmatter.title as string | undefined,
      }));
      const candidates = resolveSlug(name, pages);
      if (candidates.length === 0) {
        console.log('(no matches above minScore)');
        return;
      }
      for (const c of candidates) {
        console.log(
          `  ${c.score.toFixed(3)}  ${c.basename}${c.label ? `  (${c.label})` : ''}`,
        );
      }
      return;
    }
    case 'volume': {
      const sub = positional[0] ?? 'report';
      if (sub === 'report') {
        const history = readMetricsHistory(vaultPath);
        if (history.length === 0) {
          console.log('No volume metrics yet — run `wiki compile` first.');
          return;
        }
        const latest = history[history.length - 1];
        const rec = classifyAll(latest);
        console.log(`Volume level: ${rec.level}`);
        console.log(rec.rationale);
        console.log('');
        for (const m of rec.metrics) {
          console.log(`  ${m.name.padEnd(18)} ${m.value}  [${m.level}]`);
        }
        console.log(
          `\nFull report: reports/volume.md  (history: ${history.length} samples)`,
        );
        return;
      }
      console.error('volume subcommand: report');
      process.exit(2);
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
    case 'classify-bookmarks': {
      console.log(
        `Classifying X bookmarks (${apply ? 'APPLY' : 'DRY RUN'}): ${vaultPath}`,
      );
      const result = await classifyBookmarks(vaultPath, { apply });
      console.log('\nClassify complete:');
      console.log(`  Scanned:            ${result.scanned}`);
      console.log(`  Already classified: ${result.alreadyClassified}`);
      console.log(`  Newly classified:   ${result.classified}`);
      console.log(`  Budget-blocked:     ${result.budgetBlocked}`);
      console.log(`  LLM calls:          ${result.llmCalls}`);
      console.log(`  Duration:           ${result.durationMs}ms`);
      if (Object.keys(result.routedByHub).length > 0) {
        console.log('\nRouted by hub:');
        const hubs = Object.entries(result.routedByHub).sort(
          (a, b) => b[1] - a[1],
        );
        for (const [hub, count] of hubs) {
          console.log(`  ${hub.padEnd(14)} ${count}`);
        }
      }
      if (result.errors.length > 0) {
        console.log(`\nErrors: ${result.errors.length}`);
        for (const e of result.errors.slice(0, 5)) {
          console.log(`  ${e.file}: ${e.message}`);
        }
      }
      if (!apply && result.classified > 0) {
        console.log(
          '\n[DRY RUN] No files modified. Re-run with --apply to write.',
        );
      }
      return;
    }
    case 'backfill-hubs': {
      const force = flags.includes('--force');
      console.log(
        `Backfilling hub assignments (${apply ? 'APPLY' : 'DRY RUN'}${force ? ', FORCE' : ''}): ${vaultPath}`,
      );
      const result = runBackfillHubs(vaultPath, { apply, force });
      console.log('\nBackfill complete:');
      console.log(`  Pages scanned:     ${result.scanned}`);
      console.log(`  Already assigned:  ${result.alreadyAssigned}`);
      console.log(`  Newly assigned:    ${result.newlyAssigned}`);
      console.log(`  Skipped:           ${result.skipped}`);
      console.log(`  Pages written:     ${result.pagesWritten}`);
      console.log('\nAssignments by hub:');
      const hubs = Object.entries(result.byHub).sort((a, b) => b[1] - a[1]);
      for (const [hub, count] of hubs) {
        console.log(`  ${hub.padEnd(14)} ${count}`);
      }
      if (!apply && result.newlyAssigned > 0) {
        console.log(
          '\n[DRY RUN] No files modified. Re-run with --apply to write.',
        );
      }
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
      console.log(
        `  Timelines rewritten:  ${result.timelinePagesRewritten} (${result.timelineEntriesTotal} entries)`,
      );
      console.log(
        `  Graph:                ${result.graphNodes} nodes / ${result.graphEdges} edges`,
      );
      console.log(`  Volume level:         ${result.volumeLevel}`);
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
    case 'apply-split': {
      const slug = positional[0];
      if (!slug) {
        console.error(
          'apply-split requires a page slug, e.g. `wiki apply-split ecom-product-development`',
        );
        process.exit(2);
      }
      const proposedPath = path.join(
        vaultPath,
        '.openclaw-wiki',
        'enrichment',
        slug,
        'split-proposal.md',
      );
      if (!fs.existsSync(proposedPath)) {
        console.error(
          `apply-split: no split proposal found at ${proposedPath}`,
        );
        console.error(
          'Generate one first via the dream cycle cramming pass, then retry.',
        );
        process.exit(3);
      }
      console.error(
        `apply-split for "${slug}": NOT YET IMPLEMENTED. The proposal exists at:`,
      );
      console.error(`  ${proposedPath}`);
      console.error('');
      console.error(
        'Applying a split rewrites the parent page body, creates N child pages in',
      );
      console.error(
        'the appropriate kind directories, and rewrites inbound wikilinks. That',
      );
      console.error(
        'surgery requires human review — review the shadow proposal and wire up',
      );
      console.error('the apply path in daylight before running it.');
      process.exit(2);
    }
    case 'query': {
      // Positional question or --question flag. If no question is
      // given, we search for the rest of argv joined with spaces to
      // allow natural shell usage: `wiki query what's Dom's method?`.
      const explicit = getFlagValue(flags, args, '--question');
      const positionalQuestion =
        positional.length > 0 ? positional.join(' ').trim() : '';
      const question = (explicit ?? positionalQuestion).trim();
      if (!question) {
        console.error(
          'query requires a question, e.g. `wiki query "What is Dom\'s method?" [--save]`',
        );
        process.exit(2);
      }
      const save = flags.includes('--save');
      const limitStr = getFlagValue(flags, args, '--limit');
      const limit = limitStr ? Number(limitStr) : 20;
      console.log(`Query: "${question}"`);
      const result = await runQuery({
        vaultPath,
        question,
        limit,
        save,
      });
      console.log(
        `\n${result.results.length} result${result.results.length === 1 ? '' : 's'} (${result.durationMs}ms):\n`,
      );
      for (const r of result.results.slice(0, 10)) {
        console.log(
          `  ${r.score.toString().padStart(4)}  ${r.slug.padEnd(40)}  ${r.title}`,
        );
        if (r.snippet) {
          console.log(`         ${r.snippet.slice(0, 120)}`);
        }
      }
      if (result.results.length > 10) {
        console.log(`  … and ${result.results.length - 10} more`);
      }
      if (save && result.savedPath) {
        console.log(`\nSaved to: ${result.savedPath}`);
      } else if (save) {
        console.log(`\n[warn] --save was passed but no path was returned`);
      }
      return;
    }
    case 'op': {
      const opName = positional[0];
      if (!opName || opName === 'list') {
        const all = listOperations();
        console.log('Available operations:');
        for (const op of all) {
          console.log(`  ${op.name.padEnd(16)} ${op.description}`);
        }
        return;
      }
      const inputJson = getFlagValue(flags, args, '--input') ?? '{}';
      let parsed: unknown;
      try {
        parsed = JSON.parse(inputJson);
      } catch (err) {
        console.error(
          `op: --input is not valid JSON: ${(err as Error).message}`,
        );
        process.exit(2);
      }
      try {
        const result = await invokeOperation(vaultPath, opName, parsed);
        console.log(JSON.stringify(result, null, 2));
      } catch (err) {
        console.error(`op ${opName} failed: ${(err as Error).message}`);
        process.exit(3);
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
      console.log('  dream             Run the nightly dream cycle');
      console.log('  apply-proposal --page <slug> [--apply] [--json]');
      console.log(
        '                    Apply a shadow enrichment proposal (dry-run by default)',
      );
      console.log('  history --page <slug>             List version history');
      console.log(
        '  diff --page <slug> --from <ts> --to <ts>  Diff two versions',
      );
      console.log(
        '  revert --page <slug> --ts <ts>            Revert a page to a prior version',
      );
      console.log(
        '  graph traverse --page <slug> [--depth N]   BFS from a node',
      );
      console.log('  graph backlinks --page <slug>              Inbound edges');
      console.log('  graph path --from <slug> --to <slug>       Shortest path');
      console.log(
        '  slug resolve --name "<query>"     Trigram fuzzy slug match',
      );
      console.log(
        '  volume report                     Volume metrics + recommendation',
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
