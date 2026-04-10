/**
 * Dream cycle — nightly orchestrator.
 *
 * Runs at 03:00 CET via the `wiki-dream-nightly` cron. Five steps:
 *
 *   1. Collect pages (via the shared vault walker)
 *   2. Pick enrichment candidates (thin pages, low confidence)
 *   3. Enrichment pipeline: Tier 0 hygiene + budget-gated Tier 1 LLM
 *      proposals written to shadow files under .openclaw-wiki/enrichment/
 *   4. Compile pass — refreshes related blocks, timeline projections,
 *      digest, and lint counters so the morning agent-digest is fresh
 *   5. Dream report: morning summary at reports/dream-YYYY-MM-DD.md
 *
 * The cron never wakes Janus. Shadow proposals accumulate under
 * .openclaw-wiki/enrichment/<slug>/proposed.md; Janus picks them up on
 * his next real container spawn.
 */

import fs from 'fs';
import path from 'path';

import { compileWiki, CompileResult } from './compile.js';
import {
  DEFAULT_DREAM_BUDGET_CONFIG,
  DreamBudgetConfig,
} from './dream-budget.js';
import {
  enrichPages,
  EnrichmentRunResult,
  selectThinPages,
} from './enrichment.js';
import { appendWikiLogEvent } from './log.js';
import { collectVaultPages } from './vault-walk.js';

export interface DreamCycleOptions {
  /** Override the default budget config (per-tier USD caps, tz). */
  budget?: DreamBudgetConfig;
  /** Override current time — useful for tests and backfill runs. */
  now?: Date;
  /**
   * When true, skip the compile+lint pass at the end. Useful for tests
   * that pre-compile or want to inspect shadow proposals in isolation.
   */
  skipCompile?: boolean;
}

export interface DreamCycleResult {
  date: string;
  pagesScanned: number;
  enrichment: EnrichmentRunResult;
  compile?: CompileResult;
  reportPath: string;
  durationMs: number;
}

export async function runDreamCycle(
  vaultPath: string,
  opts: DreamCycleOptions = {},
): Promise<DreamCycleResult> {
  const startedAt = Date.now();
  const now = opts.now ?? new Date();
  const budget = opts.budget ?? DEFAULT_DREAM_BUDGET_CONFIG;

  // Step 1: pages
  const pages = collectVaultPages(vaultPath);

  // Step 2: pick candidates
  const candidates = selectThinPages(pages);

  // Step 3: enrichment
  const enrichment = await enrichPages({
    vaultPath,
    pages,
    candidates,
    budget,
    now,
  });

  // Step 4: compile (unless skipped). Compile runs timeline projection,
  // refreshes the digest, and reruns lint.
  let compile: CompileResult | undefined;
  if (!opts.skipCompile) {
    try {
      compile = await compileWiki(vaultPath);
    } catch (err) {
      // Compile failure must not break the dream cycle — the shadow
      // proposals are already on disk and Janus can still review them.
      appendWikiLogEvent(vaultPath, 'migration', {
        phase: 'dream-cycle-compile',
        error: (err as Error).message,
      });
    }
  }

  // Step 5: write the dream report
  const dateStr = now.toISOString().slice(0, 10);
  const reportPath = path.join(vaultPath, 'reports', `dream-${dateStr}.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    renderDreamReport({
      dateStr,
      pages: pages.length,
      enrichment,
      compile,
    }),
  );

  appendWikiLogEvent(vaultPath, 'compile', {
    phase: 'dream-cycle',
    candidates: enrichment.candidates,
    tier1Written: enrichment.tier1Written,
    budgetBlocked: enrichment.budgetBlocked,
    durationMs: Date.now() - startedAt,
  });

  return {
    date: dateStr,
    pagesScanned: pages.length,
    enrichment,
    compile,
    reportPath,
    durationMs: Date.now() - startedAt,
  };
}

function renderDreamReport(input: {
  dateStr: string;
  pages: number;
  enrichment: EnrichmentRunResult;
  compile?: CompileResult;
}): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`id: report.dream-${input.dateStr}`);
  lines.push('pageType: report');
  lines.push(`title: "Dream cycle ${input.dateStr}"`);
  lines.push('sourceIds: []');
  lines.push('claims: []');
  lines.push('contradictions: []');
  lines.push('questions: []');
  lines.push('confidence: 1');
  lines.push('status: active');
  lines.push(`updatedAt: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Dream cycle — ${input.dateStr}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Pages scanned: **${input.pages}**`);
  lines.push(`- Enrichment candidates: **${input.enrichment.candidates}**`);
  lines.push(`- Tier 0 hygiene applied: ${input.enrichment.tier0Applied}`);
  lines.push(
    `- Tier 1 proposals written: **${input.enrichment.tier1Written}** (of ${input.enrichment.tier1Attempted} attempted)`,
  );
  lines.push(`- Budget-blocked: ${input.enrichment.budgetBlocked}`);
  if (input.enrichment.errors.length > 0) {
    lines.push(`- Errors: ${input.enrichment.errors.length}`);
  }
  lines.push('');

  if (input.compile) {
    lines.push('## Compile');
    lines.push('');
    lines.push(
      `- Lint issues: ${input.compile.lintIssueCount} (${input.compile.lintErrorCount} err / ${input.compile.lintWarningCount} warn)`,
    );
    lines.push(
      `- Timeline projections: ${input.compile.timelinePagesRewritten} pages, ${input.compile.timelineEntriesTotal} entries`,
    );
    lines.push(`- Missing attributions: ${input.compile.missingAttributions}`);
    lines.push('');
  }

  lines.push('## Shadow proposals');
  lines.push('');
  lines.push(
    'Review and apply proposals under `.openclaw-wiki/enrichment/<slug>/proposed.md`. The dream cycle never edits live pages.',
  );
  lines.push('');

  if (input.enrichment.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const err of input.enrichment.errors.slice(0, 20)) {
      lines.push(`- \`${err.page}\`: ${err.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
