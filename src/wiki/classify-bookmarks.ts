/**
 * One-shot bookmark classifier.
 *
 * Walks every `bridge-x-bookmarks-via-ft--*.md` source page, batches
 * 10 at a time, asks Haiku to assign a hub slug, priority score, and
 * one-line summary to each one. Writes the classification back into
 * the source page's frontmatter so compile's hub projection can
 * render them on the right hub's "Things to try" block.
 *
 * Idempotent: skips bookmarks that already carry a `hub:` field.
 * Budget-gated via dream-budget at Tier 1 (Haiku).
 *
 * Output shape per bookmark:
 *   {
 *     hub: "meta-ads" | "playbooks" | "systems" | "businesses" | "me" | "none",
 *     priority: 0..1,
 *     oneLiner: "short sentence describing what to try"
 *   }
 *
 * A `hub: "none"` reply is written literally — this is the classifier's
 * way of flagging "this bookmark is noise, don't surface it." Next run
 * still skips these (they have a hub field set), so reclassification
 * is deliberate-only.
 */

import fs from 'fs';
import path from 'path';

import {
  checkDreamBudget,
  DEFAULT_DREAM_BUDGET_CONFIG,
  DreamBudgetConfig,
  markDreamBlocked,
  recordDreamSpend,
} from './dream-budget.js';
import { callClaudeCli } from './extractors/claude-cli.js';
import { atomicWriteFile } from './fs-util.js';
import {
  parseWikiPage,
  serializeWikiPage,
  WikiPageFrontmatter,
} from './markdown.js';
import { TIER_USD_ESTIMATE } from './tier.js';

const BATCH_SIZE = 10;
const BOOKMARK_PREFIX = 'bridge-x-bookmarks-via-ft--';
const VALID_HUBS = new Set([
  'meta-ads',
  'playbooks',
  'systems',
  'businesses',
  'me',
  'none',
]);

export interface ClassifyBookmarksOptions {
  apply: boolean;
  budget?: DreamBudgetConfig;
  now?: Date;
  /** Injected for tests. Defaults to the real Haiku path. */
  llmCall?: typeof callClaudeCli;
}

export interface ClassifyBookmarksResult {
  scanned: number;
  alreadyClassified: number;
  classified: number;
  routedByHub: Record<string, number>;
  budgetBlocked: number;
  llmCalls: number;
  errors: { file: string; message: string }[];
  durationMs: number;
}

interface BookmarkInput {
  filePath: string;
  id: string;
  authorHandle: string;
  text: string;
  frontmatter: WikiPageFrontmatter;
  body: string;
}

interface BookmarkDecision {
  id: string;
  hub: string;
  priority: number;
  oneLiner: string;
}

export async function classifyBookmarks(
  vaultPath: string,
  opts: ClassifyBookmarksOptions,
): Promise<ClassifyBookmarksResult> {
  const startedAt = Date.now();
  const budget = opts.budget ?? DEFAULT_DREAM_BUDGET_CONFIG;
  const now = opts.now ?? new Date();
  const llmCall = opts.llmCall ?? callClaudeCli;

  const result: ClassifyBookmarksResult = {
    scanned: 0,
    alreadyClassified: 0,
    classified: 0,
    routedByHub: {},
    budgetBlocked: 0,
    llmCalls: 0,
    errors: [],
    durationMs: 0,
  };

  const sourcesDir = path.join(vaultPath, 'sources');
  if (!fs.existsSync(sourcesDir)) {
    result.durationMs = Date.now() - startedAt;
    return result;
  }

  // Collect unclassified bookmarks.
  const queue: BookmarkInput[] = [];
  for (const name of fs.readdirSync(sourcesDir)) {
    if (!name.startsWith(BOOKMARK_PREFIX) || !name.endsWith('.md')) continue;
    const filePath = path.join(sourcesDir, name);
    result.scanned++;

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      result.errors.push({ file: name, message: (err as Error).message });
      continue;
    }
    let parsed;
    try {
      parsed = parseWikiPage(raw);
    } catch (err) {
      result.errors.push({ file: name, message: (err as Error).message });
      continue;
    }

    const existing = parsed.frontmatter.hub;
    if (typeof existing === 'string' && existing.trim().length > 0) {
      result.alreadyClassified++;
      continue;
    }

    const metadata =
      (parsed.frontmatter.extractorMetadata as Record<string, unknown>) || {};
    const text = typeof metadata.text === 'string' ? metadata.text : '';
    const handle =
      typeof metadata.authorHandle === 'string' ? metadata.authorHandle : '';
    const id =
      typeof metadata.tweetId === 'string'
        ? metadata.tweetId
        : typeof metadata.id === 'string'
          ? metadata.id
          : name;

    queue.push({
      filePath,
      id,
      authorHandle: handle,
      text,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }

  // Classify in batches.
  for (let i = 0; i < queue.length; i += BATCH_SIZE) {
    const batch = queue.slice(i, i + BATCH_SIZE);

    // Check Tier 1 budget before every LLM call.
    const check = checkDreamBudget(vaultPath, 1, budget, now);
    if (!check.allowed) {
      result.budgetBlocked += batch.length;
      markDreamBlocked(
        vaultPath,
        check.reason ?? 'classify-bookmarks: tier-1 cap reached',
        check.state,
      );
      break;
    }

    let decisions: BookmarkDecision[] = [];
    try {
      decisions = await runBatch(batch, llmCall);
      result.llmCalls++;
      recordDreamSpend(
        vaultPath,
        1,
        TIER_USD_ESTIMATE[1],
        check.state,
        now,
        budget.tz,
      );
    } catch (err) {
      for (const b of batch) {
        result.errors.push({
          file: path.basename(b.filePath),
          message: (err as Error).message,
        });
      }
      continue;
    }

    // Write decisions back to each bookmark's frontmatter.
    const decisionsById = new Map(decisions.map((d) => [d.id, d]));
    for (const bookmark of batch) {
      const decision = decisionsById.get(bookmark.id);
      if (!decision) continue;
      const hub = VALID_HUBS.has(decision.hub) ? decision.hub : 'none';
      result.classified++;
      result.routedByHub[hub] = (result.routedByHub[hub] ?? 0) + 1;

      if (!opts.apply) continue;

      const nextFm: WikiPageFrontmatter = {
        ...bookmark.frontmatter,
        hub,
        hubPriority: clamp01(decision.priority),
        hubOneLiner: decision.oneLiner || bookmark.frontmatter.title,
      };
      atomicWriteFile(
        bookmark.filePath,
        serializeWikiPage(nextFm, bookmark.body),
      );
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// =============================================================================
// Prompt + parse
// =============================================================================

const CLASSIFIER_PROMPT = `You classify bookmarked tweets into hubs for a personal second brain. You will see a list of tweets, each with an ID. For each tweet, return a JSON object with:

  - id: the exact tweet ID from the input
  - hub: one of "meta-ads", "playbooks", "systems", "businesses", "me", or "none"
  - priority: 0 to 1, how actionable and high-signal this tweet is (1 = try this soon, 0 = archive only)
  - oneLiner: one sentence under 100 chars describing what to try or why it matters

Hub definitions:
  - "meta-ads": Facebook/Instagram/Meta ads, copy frameworks, creative, media buying, CPM/ROAS, FB algorithm
  - "playbooks": Product development, wealth building, growth frameworks, coaching methodology, general e-commerce strategy (NOT ads-specific)
  - "systems": AI tools, dev tools, productivity apps, infrastructure, automation, databases, APIs
  - "businesses": Specific brand case studies, D2C operations, Shopify, fulfillment, supplier negotiation (not abstract frameworks)
  - "me": Personal OS, ADHD, health, philosophy, habits, travel, mindset
  - "none": Noise, pure entertainment, or genuinely uncategorisable

Return ONLY a JSON array like [{"id":"...","hub":"...","priority":0.7,"oneLiner":"..."}, ...] with one entry per tweet. No prose, no code fence.`;

async function runBatch(
  batch: BookmarkInput[],
  llmCall: typeof callClaudeCli,
): Promise<BookmarkDecision[]> {
  const promptTweets = batch
    .map((b) => {
      const text = b.text.slice(0, 600).replace(/\s+/g, ' ').trim();
      return `id: ${b.id}\n@${b.authorHandle}: ${text}`;
    })
    .join('\n\n---\n\n');

  const prompt = `${CLASSIFIER_PROMPT}\n\nTweets:\n\n${promptTweets}`;

  const { json, stdout } = await llmCall({
    prompt,
    model: 'claude-haiku-4-5',
    timeoutMs: 120_000,
  });

  const parsed = normaliseJsonArray(json, stdout);
  const out: BookmarkDecision[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : null;
    if (!id) continue;
    out.push({
      id,
      hub: typeof e.hub === 'string' ? e.hub : 'none',
      priority: typeof e.priority === 'number' ? e.priority : 0.5,
      oneLiner: typeof e.oneLiner === 'string' ? e.oneLiner : '',
    });
  }
  return out;
}

function normaliseJsonArray(json: unknown, stdout: string): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    // Some replies wrap the array in {"results": [...]}. Be tolerant.
    const wrapped = (json as Record<string, unknown>).results;
    if (Array.isArray(wrapped)) return wrapped;
  }
  // Last-ditch: scan stdout for a top-level JSON array. Sometimes the
  // model emits a prose preface despite the prompt asking for pure JSON.
  const match = stdout.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr;
    } catch {
      // fall through
    }
  }
  return [];
}
