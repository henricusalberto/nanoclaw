/**
 * Seeds the two recurring memory tasks for the main group:
 *   1. Daily 23:00 CET — synthesize MEMORY.md from recent memory/ files
 *   2. Weekly Sun 04:00 CET — archive memory files older than 14 days
 *
 * Both tasks mirror OpenClaw's memory cron behavior. Idempotent: re-running
 * updates the existing rows instead of creating duplicates.
 *
 * Usage:  npx tsx scripts/seed-memory-tasks.ts
 */

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../src/config.js';
import {
  createTask,
  getAllRegisteredGroups,
  getTaskById,
  initDatabase,
  updateTask,
} from '../src/db.js';

const SYNTHESIZE_TASK_ID = 'memory-synthesize-daily';
const ARCHIVE_TASK_ID = 'memory-archive-weekly';
const ENTITY_SCAN_HOURLY_TASK_ID = 'wiki-entity-scan-hourly';
const ENTITY_SCAN_MORNING_TASK_ID = 'wiki-entity-scan-morning';
const BOOKMARK_SYNC_TASK_ID = 'wiki-bookmark-sync-daily';
const DREAM_CYCLE_TASK_ID = 'wiki-dream-nightly';

const SYNTHESIZE_CRON = '0 23 * * *';
const ARCHIVE_CRON = '0 4 * * 0';
// Run every hour at :05 to process conversation windows closed since the
// last pass. Quiet hours gate suppresses LLM spend overnight.
const ENTITY_SCAN_HOURLY_CRON = '5 * * * *';
// Morning flush at 07:05 CET drains the overnight queue in one pass.
const ENTITY_SCAN_MORNING_CRON = '5 7 * * *';
// Phase 2.5: pull new X bookmarks via fieldtheory every morning at 06:00 CET.
const BOOKMARK_SYNC_CRON = '0 6 * * *';
// Phase 4: dream cycle — nightly enrichment + timeline refresh at 03:00 CET.
const DREAM_CYCLE_CRON = '0 3 * * *';

// In-container bash script: runs the wiki CLI, prints JSON result. The
// {wakeAgent: false} marker keeps the scheduler from spawning Janus for
// this task — entity-scan produces candidates; Janus picks them up on
// the next real container spawn.
const ENTITY_SCAN_HOURLY_SCRIPT = `#!/bin/bash
set -e
cd /workspace/project
npx tsx src/wiki/cli.ts entity-scan > /tmp/entity-scan.log 2>&1 || true
tail -30 /tmp/entity-scan.log
echo '{"wakeAgent": false}'`;

const ENTITY_SCAN_MORNING_SCRIPT = `#!/bin/bash
set -e
cd /workspace/project
npx tsx src/wiki/cli.ts entity-scan --morning > /tmp/entity-scan-morning.log 2>&1 || true
tail -30 /tmp/entity-scan-morning.log
echo '{"wakeAgent": false}'`;

const ENTITY_SCAN_PROMPT =
  'Process conversation-window entity queue (handled by script — agent should not be woken).';

// Phase 2.5: bookmark sync cron — runs the bridge, which walks pull sources.
// The bridge handles fieldtheory internally; no agent wake required.
const BOOKMARK_SYNC_SCRIPT = `#!/bin/bash
set -e
cd /workspace/project
npx tsx src/wiki/cli.ts bridge > /tmp/wiki-bookmark-sync.log 2>&1 || true
tail -30 /tmp/wiki-bookmark-sync.log
echo '{"wakeAgent": false}'`;

const BOOKMARK_SYNC_PROMPT =
  'Sync X bookmarks via fieldtheory into wiki sources/ (handled by script — agent should not be woken).';

// Phase 4 dream-cycle cron. Runs enrichment + timeline projection +
// compile autonomously. Writes shadow proposals to .openclaw-wiki/
// enrichment/ — Janus curates on his next real wake-up.
const DREAM_CYCLE_SCRIPT = `#!/bin/bash
set -e
cd /workspace/project
npx tsx src/wiki/cli.ts dream > /tmp/wiki-dream.log 2>&1 || true
tail -50 /tmp/wiki-dream.log
echo '{"wakeAgent": false}'`;

const DREAM_CYCLE_PROMPT =
  'Run the nightly dream cycle (handled by script — agent should not be woken).';

const SYNTHESIZE_PROMPT = `Synthesize today's memory files into MEMORY.md.

1. Glob /workspace/global/memory/$(date -u +%Y-%m-%d)*.md to find today's entries.
2. Read the existing /workspace/global/MEMORY.md.
3. Merge meaningful new facts/decisions/lessons from today's files into MEMORY.md.
   - Keep MEMORY.md under 80 lines total.
   - Prune the oldest or least-relevant entries to stay under the limit.
   - Preserve the existing section structure (Operational Lessons, business sections, etc).
   - Only add things that will still matter weeks from now. Skip ephemeral details.
4. Update the "_Last synthesized_" header line with the current CET timestamp.
5. If today produced no memory files, do nothing and reply "No memory to synthesize today."

Reply with a one-line summary of what changed.`;

// Bash-only archive script — runs without waking the agent. Files older than
// 14 days move from memory/ into memory/archive/ and remain searchable.
const ARCHIVE_SCRIPT = `#!/bin/bash
set -e
MEMORY_DIR="/workspace/global/memory"
ARCHIVE_DIR="$MEMORY_DIR/archive"
mkdir -p "$ARCHIVE_DIR"
moved=0
while IFS= read -r f; do
  mv "$f" "$ARCHIVE_DIR/" && moved=$((moved+1))
done < <(find "$MEMORY_DIR" -maxdepth 1 -type f -name '20*.md' -mtime +14)
echo "{\\"wakeAgent\\": false, \\"data\\": {\\"archived\\": $moved}}"`;

const ARCHIVE_PROMPT = 'Archive memory files older than 14 days (handled by script — agent should not be woken).';

function nextRun(cron: string): string {
  const tz = TIMEZONE || 'UTC';
  const next = CronExpressionParser.parse(cron, { tz }).next().toISOString();
  if (!next) throw new Error(`Failed to compute next run for cron: ${cron}`);
  return next;
}

function upsertTask(opts: {
  id: string;
  groupFolder: string;
  chatJid: string;
  prompt: string;
  script: string | null;
  cron: string;
}): void {
  const existing = getTaskById(opts.id);
  if (existing) {
    updateTask(opts.id, {
      prompt: opts.prompt,
      script: opts.script,
      schedule_type: 'cron',
      schedule_value: opts.cron,
      next_run: nextRun(opts.cron),
      status: 'active',
    });
    console.log(`Updated existing task: ${opts.id}`);
    return;
  }
  createTask({
    id: opts.id,
    group_folder: opts.groupFolder,
    chat_jid: opts.chatJid,
    prompt: opts.prompt,
    script: opts.script,
    schedule_type: 'cron',
    schedule_value: opts.cron,
    context_mode: 'isolated',
    next_run: nextRun(opts.cron),
    status: 'active',
    created_at: new Date().toISOString(),
  });
  console.log(`Created task: ${opts.id}`);
}

function main(): void {
  initDatabase();
  const groups = getAllRegisteredGroups();
  const main = Object.entries(groups).find(([, g]) => g.isMain === true);
  if (!main) {
    console.error('No main group registered. Run /setup first.');
    process.exit(1);
  }
  const [chatJid, group] = main;
  console.log(`Main group: ${group.name} (folder=${group.folder})`);

  upsertTask({
    id: SYNTHESIZE_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: SYNTHESIZE_PROMPT,
    script: null,
    cron: SYNTHESIZE_CRON,
  });

  upsertTask({
    id: ARCHIVE_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: ARCHIVE_PROMPT,
    script: ARCHIVE_SCRIPT,
    cron: ARCHIVE_CRON,
  });

  upsertTask({
    id: ENTITY_SCAN_HOURLY_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: ENTITY_SCAN_PROMPT,
    script: ENTITY_SCAN_HOURLY_SCRIPT,
    cron: ENTITY_SCAN_HOURLY_CRON,
  });

  upsertTask({
    id: ENTITY_SCAN_MORNING_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: ENTITY_SCAN_PROMPT,
    script: ENTITY_SCAN_MORNING_SCRIPT,
    cron: ENTITY_SCAN_MORNING_CRON,
  });

  upsertTask({
    id: BOOKMARK_SYNC_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: BOOKMARK_SYNC_PROMPT,
    script: BOOKMARK_SYNC_SCRIPT,
    cron: BOOKMARK_SYNC_CRON,
  });

  upsertTask({
    id: DREAM_CYCLE_TASK_ID,
    groupFolder: group.folder,
    chatJid,
    prompt: DREAM_CYCLE_PROMPT,
    script: DREAM_CYCLE_SCRIPT,
    cron: DREAM_CYCLE_CRON,
  });

  console.log('Done. Memory tasks seeded.');
}

main();
