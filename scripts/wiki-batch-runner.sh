#!/bin/bash
# Wiki batch ingest runner
# Triggers batches 2-10 sequentially by inserting fake user messages
# into the wiki-inbox group's message table, then waits for each
# container to finish before triggering the next.
#
# One-shot script. Delete after the wiki ingest is done.

set -e
cd "$(dirname "$0")/.."

DB="store/messages.db"
JID="tg:-1003907911824:topic:14"
SENDER="942625848"
SENDER_NAME="Mao"
LOG="logs/wiki-batch-runner.log"
mkdir -p logs

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"
}

# Insert a fake user message into the wiki-inbox messages table.
# Uses python for safe SQL parameter binding.
send_msg() {
  local n="$1"
  local content="$2"
  local id="wiki-batch-$n-$(date +%s)"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  python3 - "$DB" "$id" "$JID" "$SENDER" "$SENDER_NAME" "$content" "$ts" <<'PY'
import sqlite3, sys
db, msg_id, jid, sender, sender_name, content, ts = sys.argv[1:]
con = sqlite3.connect(db)
con.execute(
  "INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, 0, 0)",
  (msg_id, jid, sender, sender_name, content, ts),
)
con.commit()
con.close()
PY
}

# Wait until wiki/log.md grows by a new "## [date] ingest" entry beyond
# the baseline count we captured before the batch was sent. Janus appends
# an entry after each batch per the wiki SKILL.md.
LOG_MD="groups/telegram_wiki-inbox/wiki/log.md"

count_log_entries() {
  grep -c '^## \[' "$LOG_MD" 2>/dev/null || echo 0
}

wait_for_batch() {
  local n="$1"
  local baseline="$2"
  local target=$((baseline + 1))
  log "Waiting for batch $n: log.md entry count to reach $target (was $baseline)..."
  local timeout=1800  # 30 min
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    local cur
    cur=$(count_log_entries)
    if [ "$cur" -ge "$target" ]; then
      log "Batch $n complete (log.md now has $cur entries)"
      sleep 5  # let any straggler writes settle

      # The SDK query generator can hang after emitting result, leaving the
      # container alive but unresponsive to follow-up IPC. Force-close it so
      # the next batch gets a fresh container that resumes the same session
      # via NanoClaw's sessionId tracking.
      log "Writing _close sentinel to force container exit between batches..."
      touch "data/ipc/telegram_wiki-inbox/input/_close"
      sleep 8
      # Hard-kill if still running after grace period
      docker ps --format '{{.Names}}' | grep '^nanoclaw-telegram-wiki-inbox' | while read -r name; do
        log "Force-killing lingering container $name"
        docker kill "$name" >/dev/null 2>&1 || true
      done
      sleep 5
      return 0
    fi
    sleep 20
    elapsed=$((elapsed + 20))
  done
  log "TIMEOUT: batch $n exceeded 30 min"
  return 1
}

# Run a single batch end-to-end
run_batch() {
  local n="$1"
  local prompt="$2"
  log "=== BATCH $n START ==="
  local baseline
  baseline=$(count_log_entries)
  log "log.md baseline before batch $n: $baseline entries"
  send_msg "$n" "$prompt"
  wait_for_batch "$n" "$baseline" || return 1
  log "=== BATCH $n DONE ==="
  sleep 20
}

# Common preamble inserted into every batch prompt so Janus knows the rules
PREAMBLE='Execute the next batch of the wiki ingest. The full plan is in wiki/_ingest-plan.md. Use [[wiki-link]] style for cross-references. Update wiki/index.md and append to wiki/log.md. Reply with a short summary: pages touched and key takeaways.

CRITICAL: read all the files in this batch TOGETHER as one coherent narrative. Do NOT process them individually. The strict one-at-a-time discipline does not apply within a batch.'

START_BATCH=${START_BATCH:-2}

log "=========================="
log "Wiki batch runner starting (from batch $START_BATCH)"
log "=========================="

[ "$START_BATCH" -le 2 ] && run_batch 2 "$PREAMBLE

BATCH 2 — Sep 2025 dom calls (~14 files, Daily Sip era: mockups, marketing angles, ingredients)
Files: glob 'sources/2025-09-*dom-call*.md'"

[ "$START_BATCH" -le 3 ] && run_batch 3 "$PREAMBLE

BATCH 3 — Oct 2025 dom calls (~12 files, Daily Sip era: articles, advertorials, product page)
Files: glob 'sources/2025-10-*dom-call*.md'"

[ "$START_BATCH" -le 4 ] && run_batch 4 "$PREAMBLE

BATCH 4 — Nov 2025 dom calls (~12 files, Daily Sip era: sample, klaviyo, launch prep, LAUNCH)
Files: glob 'sources/2025-11-*dom-call*.md'"

[ "$START_BATCH" -le 5 ] && run_batch 5 "$PREAMBLE

BATCH 5 — Dec 2025 dom calls (~11 files, Daily Sip era: first results, hard analysis, the pivot decision)
Files: glob 'sources/2025-12-*dom-call*.md'"

[ "$START_BATCH" -le 6 ] && run_batch 6 "$PREAMBLE

BATCH 6 — Jan 2026 dom calls (~16 files): the PIVOT to Nightcap, name change, repositioning. This is a major narrative turning point — the brand transitions from Daily Sip to Nightcap.
Files: glob 'sources/2026-01-*dom-call*.md'"

[ "$START_BATCH" -le 7 ] && run_batch 7 "$PREAMBLE

BATCH 7 — Feb 2026 dom calls (~10 files) PLUS the 27 non-dated business knowledge files (master-knowledge, nightcap-formula, ad-copy, landing pages, runbooks, playbooks, etc).
Files: glob 'sources/2026-02-*dom-call*.md' AND all non-dated *.md files in sources/ (e.g. nightcap-formula.md, master-knowledge.md, ad-copy-rewrites-feb26.md, ad-metrics-sop.md, architecture.md, business-rules.md, creative-review-feb26.md, dashboard-v2.md, errors.md, feature-requests.md, finance-system-rebuild.md, homepage-v1.md, landing-page-copy-mar10.md, learnings.md, memory.md, nightcap-product-page-copy.md, optimization-intelligence-layer.md, pipeline.md, profile.md, qc-report.md, readme.md, runbook.md, user.md, dreams.md, nanoclaw-operational-memory.md, user-context.md). The Feb dom calls = repositioning narrative; the knowledge files = playbooks/SOPs/reference material that should populate concepts and tools sections of the wiki."

[ "$START_BATCH" -le 8 ] && run_batch 8 "$PREAMBLE

BATCH 8 — Mar 2026 dom calls (~20 files, Nightcap era: scaling, native ads, current state). This catches up to the present.
Files: glob 'sources/2026-03-*dom-call*.md'"

[ "$START_BATCH" -le 9 ] && run_batch 9 "$PREAMBLE

BATCH 9 — All operational memory files. ~225 files total: dated memory files from sources/ that are NOT dom calls (Feb 22 - Apr 2026), plus the overnight reports. These are short daily snapshots of what was happening operationally, not just business — use them to build a Maurizio operational journal, lessons-learned page, and pull out recurring themes (system issues, life events, decisions, learnings).
Files: glob 'sources/2026-*.md' AND 'sources/2025-*.md' EXCLUDING dom-call files. So: every dated file in sources/ that is NOT a dom-call file."

[ "$START_BATCH" -le 10 ] && run_batch 10 "$PREAMBLE

BATCH 10 — FINAL SYNTHESIS PASS. Do NOT read sources/ for this. Read the entire wiki/ tree that you have built across batches 1-9. Then:

1. Write top-level synthesis pages: maurizio.md (the person — life context, current focus), current-state.md (where everything stands as of April 2026), frameworks.md (recurring mental models from across the wiki), tools-and-systems.md (operational stack).
2. Refresh wiki/index.md to reflect the final structure of the wiki across all categories.
3. Look for cross-reference gaps — if entity A is mentioned in 3+ pages but lacks its own page, create it.
4. Look for orphan pages — any page with no inbound links — and add backlinks where appropriate.
5. Append a final synthesis log entry to wiki/log.md.
6. Reply with a 'wiki health' summary: total pages by category, suggested next ingests if any, anything you flagged as a gap."

log "=========================="
log "ALL BATCHES COMPLETE"
log "=========================="
