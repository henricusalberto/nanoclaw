/**
 * Thin wrapper around the existing `search` operation that adds a
 * "save to report" mode for reusable query artefacts.
 *
 * Runs a structured search (title-boost + body substring, no LLM
 * synthesis yet) and optionally writes the result to
 * `reports/queries/<YYYY-MM-DD>-<slug>.md` with the standard report
 * frontmatter. Janus / a future tiered-enrichment pass can read the
 * saved artefact to answer follow-ups without re-running the search.
 *
 * Deliberately does NOT call Sonnet/Opus. Overnight wiki work stays
 * LLM-free; adding synthesis is a daylight follow-up.
 */

import fs from 'fs';
import path from 'path';

import { atomicWriteFile } from './fs-util.js';
import { invokeOperation } from './operations.js';

export interface RunQueryInput {
  vaultPath: string;
  question: string;
  limit?: number;
  save?: boolean;
  now?: Date;
}

export interface QueryResultRow {
  slug: string;
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
}

export interface RunQueryResult {
  question: string;
  results: QueryResultRow[];
  savedPath?: string;
  durationMs: number;
}

export async function runQuery(input: RunQueryInput): Promise<RunQueryResult> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const limit = input.limit ?? 20;

  const searchResult = (await invokeOperation(input.vaultPath, 'search', {
    query: input.question,
    limit,
  })) as { results: QueryResultRow[] };

  const results = Array.isArray(searchResult?.results)
    ? searchResult.results
    : [];

  const out: RunQueryResult = {
    question: input.question,
    results,
    durationMs: Date.now() - startedAt,
  };

  if (input.save) {
    const savedPath = writeQueryReport(
      input.vaultPath,
      input.question,
      results,
      now,
    );
    out.savedPath = savedPath;
  }

  return out;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function writeQueryReport(
  vaultPath: string,
  question: string,
  results: QueryResultRow[],
  now: Date,
): string {
  const dir = path.join(vaultPath, 'reports', 'queries');
  fs.mkdirSync(dir, { recursive: true });

  const dateStr = now.toISOString().slice(0, 10);
  const slug = slugify(question) || 'query';
  const filename = `${dateStr}-${slug}.md`;
  const filePath = path.join(dir, filename);

  const id = `report.query-${dateStr}-${slug}`;
  const frontmatter = [
    '---',
    `id: ${id}`,
    'pageType: report',
    `title: "Query: ${escapeYaml(question)}"`,
    'sourceIds: []',
    'claims: []',
    'contradictions: []',
    'questions: []',
    'confidence: 1',
    'status: active',
    `updatedAt: "${now.toISOString()}"`,
    '---',
    '',
  ].join('\n');

  const body: string[] = [];
  body.push(`# Query: ${question}`);
  body.push('');
  body.push(
    `_Ran ${now.toISOString()}. ${results.length} result${results.length === 1 ? '' : 's'}._`,
  );
  body.push('');

  if (results.length === 0) {
    body.push(
      'No matching pages found. Try different keywords or a broader search term.',
    );
    body.push('');
  } else {
    body.push('## Matching pages');
    body.push('');
    for (const r of results) {
      body.push(`### [[${r.slug}|${r.title}]]`);
      body.push('');
      body.push(`\`${r.relativePath}\` · score ${r.score}`);
      body.push('');
      if (r.snippet) {
        body.push('> ' + r.snippet.replace(/\n+/g, ' ').trim());
        body.push('');
      }
    }
  }

  body.push('## Review and synthesise');
  body.push('');
  body.push(
    '_This section is a placeholder. Janus or a future tiered-enrichment pass can fill it with a synthesised answer that cites the pages above. The raw search results are preserved above so the synthesis is reproducible._',
  );
  body.push('');

  atomicWriteFile(filePath, frontmatter + body.join('\n'));
  return filePath;
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
