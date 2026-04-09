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

const SYNTHESIZE_CRON = '0 23 * * *';
const ARCHIVE_CRON = '0 4 * * 0';

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

  console.log('Done. Memory tasks seeded.');
}

main();
