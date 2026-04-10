/**
 * Volume checker — recommends when the vault has grown big enough to
 * warrant SQLite + FTS5. Pure measurement, no installation. Appends
 * one metric snapshot per compile to `.openclaw-wiki/volume-metrics.jsonl`
 * and writes a recommendation block to `reports/volume.md`.
 *
 * Three threshold levels per metric: WATCH → RECOMMEND → BUILD NOW.
 * The aggregate recommendation fires when:
 *   - 2+ metrics reach WATCH, OR
 *   - 1 metric reaches RECOMMEND, OR
 *   - any metric reaches BUILD NOW
 *
 * Maurizio decides whether to actually invest in FTS5; this module
 * just keeps an honest count.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { vaultPaths } from './paths.js';

export interface VolumeMetrics {
  /** ISO timestamp of the snapshot. */
  ts: string;
  pageCount: number;
  claimCount: number;
  bytesMarkdown: number;
  compileTimeMs: number;
  lintTimeMs: number;
  /** Sliding-window count of pages added in the last 30 days. */
  pagesAdded30d: number;
}

export type ThresholdLevel = 'OK' | 'WATCH' | 'RECOMMEND' | 'BUILD NOW';

export interface MetricThresholds {
  watch: number;
  recommend: number;
  buildNow: number;
}

export const THRESHOLDS: Record<
  keyof Omit<VolumeMetrics, 'ts'>,
  MetricThresholds
> = {
  pageCount: { watch: 150, recommend: 300, buildNow: 500 },
  claimCount: { watch: 500, recommend: 1500, buildNow: 4000 },
  bytesMarkdown: {
    watch: 500_000,
    recommend: 2_000_000,
    buildNow: 5_000_000,
  },
  compileTimeMs: { watch: 500, recommend: 2000, buildNow: 5000 },
  lintTimeMs: { watch: 1000, recommend: 3000, buildNow: 8000 },
  pagesAdded30d: { watch: 30, recommend: 60, buildNow: 120 },
};

export function classify(
  value: number,
  thresholds: MetricThresholds,
): ThresholdLevel {
  if (value >= thresholds.buildNow) return 'BUILD NOW';
  if (value >= thresholds.recommend) return 'RECOMMEND';
  if (value >= thresholds.watch) return 'WATCH';
  return 'OK';
}

export interface VolumeRecommendation {
  level: ThresholdLevel;
  /** Per-metric breakdown so the report can show the table directly. */
  metrics: { name: string; value: number; level: ThresholdLevel }[];
  /** Short human-readable rationale. */
  rationale: string;
}

export function classifyAll(metrics: VolumeMetrics): VolumeRecommendation {
  const breakdown: { name: string; value: number; level: ThresholdLevel }[] =
    [];
  for (const [name, thresholds] of Object.entries(THRESHOLDS)) {
    const value = (metrics as unknown as Record<string, number>)[name] ?? 0;
    breakdown.push({ name, value, level: classify(value, thresholds) });
  }

  const buildNow = breakdown.filter((b) => b.level === 'BUILD NOW');
  const recommend = breakdown.filter((b) => b.level === 'RECOMMEND');
  const watch = breakdown.filter((b) => b.level === 'WATCH');

  let level: ThresholdLevel = 'OK';
  let rationale = 'Vault is well within markdown-only limits.';
  if (buildNow.length > 0) {
    level = 'BUILD NOW';
    rationale = `${buildNow.map((b) => b.name).join(', ')} crossed BUILD NOW threshold — invest in SQLite + FTS5 now.`;
  } else if (recommend.length >= 1) {
    level = 'RECOMMEND';
    rationale = `${recommend.map((b) => b.name).join(', ')} crossed RECOMMEND threshold — start planning the FTS5 migration.`;
  } else if (watch.length >= 2) {
    level = 'RECOMMEND';
    rationale = `${watch.map((b) => b.name).join(', ')} all in WATCH range — escalating to RECOMMEND.`;
  } else if (watch.length === 1) {
    level = 'WATCH';
    rationale = `${watch[0].name} reached WATCH — monitor over next compile passes.`;
  }

  return { level, metrics: breakdown, rationale };
}

// =============================================================================
// Persistence
// =============================================================================

function metricsPath(vaultPath: string): string {
  return path.join(vaultPaths(vaultPath).stateDir, 'volume-metrics.jsonl');
}

export function appendMetricsSnapshot(
  vaultPath: string,
  metrics: VolumeMetrics,
): void {
  const file = metricsPath(vaultPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(metrics) + '\n');
}

export function readMetricsHistory(vaultPath: string): VolumeMetrics[] {
  const file = metricsPath(vaultPath);
  if (!fs.existsSync(file)) return [];
  const out: VolumeMetrics[] = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as VolumeMetrics);
    } catch {
      // skip
    }
  }
  return out;
}

// =============================================================================
// Report writer
// =============================================================================

export function writeVolumeReport(
  vaultPath: string,
  metrics: VolumeMetrics,
  recommendation: VolumeRecommendation,
): string {
  const reportDir = path.join(vaultPath, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'volume.md');

  const lines: string[] = [];
  lines.push('---');
  lines.push('id: report.volume');
  lines.push('pageType: report');
  lines.push('title: "Volume metrics"');
  lines.push('sourceIds: []');
  lines.push('claims: []');
  lines.push('contradictions: []');
  lines.push('questions: []');
  lines.push('confidence: 1');
  lines.push('status: active');
  lines.push(`updatedAt: ${metrics.ts}`);
  lines.push('---');
  lines.push('');
  lines.push('# Volume metrics');
  lines.push('');
  lines.push(`**Recommendation level:** \`${recommendation.level}\``);
  lines.push('');
  lines.push(recommendation.rationale);
  lines.push('');
  lines.push('## Snapshot');
  lines.push('');
  lines.push('| Metric | Value | Level | Watch | Recommend | Build Now |');
  lines.push('|---|---:|---|---:|---:|---:|');
  for (const m of recommendation.metrics) {
    const t = THRESHOLDS[m.name as keyof typeof THRESHOLDS];
    lines.push(
      `| ${m.name} | ${m.value} | \`${m.level}\` | ${t.watch} | ${t.recommend} | ${t.buildNow} |`,
    );
  }
  lines.push('');
  lines.push(`_Last sampled at ${metrics.ts}_`);
  lines.push('');

  atomicWriteFile(reportPath, lines.join('\n'));
  return reportPath;
}
