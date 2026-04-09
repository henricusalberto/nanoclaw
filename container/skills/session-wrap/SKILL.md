---
name: session-wrap
description: "End-of-session wrap procedure. Use when the user sends /wrap or asks to wrap up the session. Handles updating business READMEs, writing memory files, and confirming completion."
---

# Session Wrap

When user sends `/wrap`:

## Step 1 — Update Business READMEs

For each business touched this session, update its `BUSINESSES/<name>/README.md` "Current State" section (if the file exists):
- Status (active/blocked/paused)
- Key metrics (revenue, ROAS, etc. if relevant)
- Blockers
- Next action
- Last updated date (CET)

Business README paths (under `/workspace/global/`):
- Pinterest: `BUSINESSES/pinterest-store/README.md`
- Coaching: `BUSINESSES/coaching/README.md`
- Revive Plus: `BUSINESSES/reviveplus/README.md`

Skip silently if a business README doesn't exist yet.

## Step 2 — Write Memory File

Write to `/workspace/global/memory/YYYY-MM-DD-<topic-slug>.md` (today's date in CET, short topic descriptor).

- Append to existing file if one exists for today's topic; create if not
- Never overwrite another session's file
- Each entry: 3-5 lines max

Include:
- What was done (decisions, completions, pivots)
- Blockers discovered or resolved
- Any credential/config/system changes
- Business status changes

## Step 3 — Confirm

Reply: "Session wrapped. [list files updated]"

## Rules

- Use CET for all dates and timestamps
- Topic slug = short descriptor (e.g. `dashboard`, `coaching`, `pipeline`)
- Do not wait for /wrap to write memory mid-session — write immediately when significant events occur
- Also update `LEARNINGS.md`, `ERRORS.md`, `FEATURE_REQUESTS.md` (under `/workspace/global/`) when relevant content surfaces
- Memory files live under `/workspace/global/memory/` (writable from main group only). Non-main groups should write to `/workspace/group/memory/` instead.
