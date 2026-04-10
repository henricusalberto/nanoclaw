#!/usr/bin/env node
/**
 * Pure-JS entity-scan backfill that runs inside the agent container
 * via the @anthropic-ai/claude-agent-sdk. Bypasses both:
 *   1. The host esbuild platform mismatch that breaks `npx tsx` in
 *      the container.
 *   2. The standalone `claude` CLI's "Not logged in" check that
 *      rejects the OneCLI placeholder token.
 *
 * Walks every bridged memory source page in
 * /workspace/wiki-inbox/wiki/sources/, extracts the fenced ```markdown
 * body, asks Haiku to pull entities + originals, validates each quote
 * appears in the input text, and appends candidates to
 * .openclaw-wiki/entity-candidates.jsonl.
 *
 * Run via:
 *   docker run --rm \
 *     -v <project>:/workspace/project:ro \
 *     -v <wiki-inbox>:/workspace/wiki-inbox:rw \
 *     ... onecli env ... \
 *     --entrypoint /bin/bash nanoclaw-agent:latest \
 *     -c 'cd /app && node /workspace/project/scripts/backfill-entities-via-sdk.js'
 */

const fs = require('fs');
const path = require('path');
const { query } = require('@anthropic-ai/claude-agent-sdk');

const VAULT = '/workspace/wiki-inbox/wiki';
const SOURCES_DIR = path.join(VAULT, 'sources');
const STATE_DIR = path.join(VAULT, '.openclaw-wiki');
const CANDIDATES_FILE = path.join(STATE_DIR, 'entity-candidates.jsonl');
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '200', 10);

const PROMPT_PREFIX = `Extract named entities and original-thinking quotes from the following text. Return ONLY a JSON object with this exact shape, no prose, no code fence:
{
  "entities": [{"name": "<canonical name>", "type": "<person|company|tool|concept|product>", "quote": "<verbatim short quote from the text that supports this entity>"}],
  "originals": [{"quote": "<verbatim distinctive thought worth preserving, max 200 chars>"}]
}

Rules:
- The "quote" field MUST be a literal substring of the input text (verbatim, no paraphrase).
- Return at most 5 entities and 2 originals per call.
- If the text is too noisy (greetings, fragments), return empty arrays.

TEXT:
`;

function extractFencedMarkdown(raw) {
  const m = raw.match(/```markdown\n([\s\S]*?)\n```/);
  return m ? m[1] : '';
}

function tryParseJson(s) {
  if (!s || typeof s !== 'string') return null;
  let cleaned = s.trim();
  // Be forgiving about fenced JSON.
  if (cleaned.startsWith('```')) {
    const lines = cleaned.split('\n');
    lines.shift();
    if (lines[lines.length - 1] && lines[lines.length - 1].startsWith('```')) {
      lines.pop();
    }
    cleaned = lines.join('\n');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function validate(parsed, text) {
  if (!parsed || typeof parsed !== 'object') {
    return { entities: [], originals: [] };
  }
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const originals = Array.isArray(parsed.originals) ? parsed.originals : [];
  return {
    entities: entities.filter(
      (e) =>
        e &&
        typeof e.name === 'string' &&
        typeof e.quote === 'string' &&
        e.quote.length > 0 &&
        text.includes(e.quote),
    ),
    originals: originals.filter(
      (o) =>
        o && typeof o.quote === 'string' && o.quote.length > 0 && text.includes(o.quote),
    ),
  };
}

async function callHaiku(prompt) {
  // Use the same SDK path the agent runtime uses. permissionMode bypass
  // because no tools should fire. allowedTools empty so we get a pure
  // text completion.
  const stream = query({
    prompt,
    options: {
      permissionMode: 'bypassPermissions',
      model: 'claude-haiku-4-5',
      allowedTools: [],
    },
  });
  let result = '';
  for await (const msg of stream) {
    if (msg.type === 'result' && typeof msg.result === 'string') {
      result = msg.result;
    }
  }
  return result;
}

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  if (!fs.existsSync(SOURCES_DIR)) {
    console.log('[backfill] no sources dir; aborting');
    return;
  }

  const files = fs
    .readdirSync(SOURCES_DIR)
    .filter(
      (f) =>
        (f.startsWith('bridge-global-memory-') ||
          f.startsWith('bridge-all-groups-memory-')) &&
        f.endsWith('.md'),
    )
    .map((f) => path.join(SOURCES_DIR, f));

  console.log(`[backfill] candidates: ${files.length} memory source pages`);
  console.log(`[backfill] cap: ${MAX_PAGES} pages`);

  let processed = 0;
  let entityCount = 0;
  let originalCount = 0;
  let llmCalls = 0;
  let appended = '';

  for (const filePath of files) {
    if (processed >= MAX_PAGES) {
      console.log(`[backfill] hit MAX_PAGES=${MAX_PAGES}; stopping`);
      break;
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const text = extractFencedMarkdown(raw);
    if (!text || text.length < 80) continue;

    const basename = path.basename(filePath, '.md');
    const ts = new Date().toISOString();

    let response;
    try {
      response = await callHaiku(PROMPT_PREFIX + text);
      llmCalls++;
    } catch (err) {
      console.error(`[backfill] ${basename}: SDK error: ${err.message || err}`);
      continue;
    }

    const parsed = tryParseJson(response);
    const valid = validate(parsed, text);
    if (valid.entities.length === 0 && valid.originals.length === 0) {
      processed++;
      console.log(`[backfill] ${processed}/${MAX_PAGES} ${basename}: empty`);
      continue;
    }

    const window = {
      windowId: `backfill:${basename}`,
      groupFolder: 'backfill-source',
      openedAt: ts,
      closedAt: ts,
    };
    for (const e of valid.entities) {
      appended += JSON.stringify({
        kind: 'entity-candidate',
        name: e.name,
        entityType: e.type || 'unknown',
        quote: e.quote,
        window,
        extractedAt: ts,
      }) + '\n';
      entityCount++;
    }
    for (const o of valid.originals) {
      appended += JSON.stringify({
        kind: 'original-thinking',
        name: '',
        quote: o.quote,
        window,
        extractedAt: ts,
      }) + '\n';
      originalCount++;
    }

    // Flush every 10 pages so partial progress survives crashes.
    if (appended.length > 0 && processed % 10 === 9) {
      fs.appendFileSync(CANDIDATES_FILE, appended);
      appended = '';
    }

    processed++;
    console.log(
      `[backfill] ${processed}/${MAX_PAGES} ${basename}: +${valid.entities.length} entities, +${valid.originals.length} originals`,
    );
  }

  if (appended.length > 0) {
    fs.appendFileSync(CANDIDATES_FILE, appended);
  }

  console.log('');
  console.log(`[backfill] DONE`);
  console.log(`  pages processed:  ${processed}`);
  console.log(`  llm calls:        ${llmCalls}`);
  console.log(`  entities:         ${entityCount}`);
  console.log(`  originals:        ${originalCount}`);
  if (fs.existsSync(CANDIDATES_FILE)) {
    const total = fs.readFileSync(CANDIDATES_FILE, 'utf-8').split('\n').filter(Boolean).length;
    console.log(`  total candidates in file: ${total}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
