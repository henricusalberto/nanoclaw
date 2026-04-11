---
name: session-wrap
description: "End-of-session wrap procedure. Use when the user sends /wrap or asks to wrap up the session. Handles updating business READMEs, writing memory files, and confirming completion."
---

# Session Wrap

When user sends `/wrap`:

## Step 1 — Update Business and System READMEs

For each business or system touched this session, update the page's `## Current State` block AND `## Handoff` block. Both live in the README. Don't invent new sections. If neither block exists yet, add them in that order right after the top of the file, before the stable sections (Team, Stack, API Access, etc.).

**Current State block** — the right-now snapshot:
- Status line (🟢 active / 🟡 blocked / 🔴 paused) with one-line reason
- Key metrics (revenue, ROAS, open issues, whatever is relevant for that business)
- Blockers list
- Next action list
- `_Updated: YYYY-MM-DD CET_` on the first line under the heading

**Handoff block** — the "what the last session did" record:
- `_Last worked by: <agent name> — YYYY-MM-DD_` line
- **Status:** one paragraph describing what the last session accomplished
- **Next:** numbered list of concrete next actions for whoever picks this up
- **Blockers:** anything waiting on an external dependency

The OpenClaw workspace is mounted read-write inside every group container. Use these paths:

**Businesses** (under `/workspace/extra/workspace/BUSINESSES/`):
- Pinterest:    `/workspace/extra/workspace/BUSINESSES/pinterest-store/README.md`
- Coaching:     `/workspace/extra/workspace/BUSINESSES/coaching/README.md`
- Revive Plus:  `/workspace/extra/workspace/BUSINESSES/reviveplus/README.md`
- Ops Hub:      `/workspace/extra/workspace/BUSINESSES/ops-hub/README.md`
- Playbooks:    `/workspace/extra/workspace/BUSINESSES/playbooks/README.md` (if exists)

**Systems** (under `/workspace/extra/workspace/SYSTEMS/`):
- Finance:          `/workspace/extra/workspace/SYSTEMS/finance/README.md`
- Planning System:  `/workspace/extra/workspace/SYSTEMS/planning-system/README.md`

**Alternate path (same file, via `mountAtHostPath` for OpenClaw script compat)**: the same paths are also reachable at `/Users/kimbehnke/.openclaw/workspace/...` inside the container. Either works; prefer the `/workspace/extra/workspace/` form in new writing since it's portable.

Skip silently if a README doesn't exist yet. Don't create empty stubs.

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
- Also update `LEARNINGS.md`, `ERRORS.md`, `FEATURE_REQUESTS.md` at `/workspace/extra/workspace/` (the OpenClaw workspace root) when relevant content surfaces. These are shared across all businesses — LEARNINGS for durable insights, ERRORS for bugs hit and how they were fixed, FEATURE_REQUESTS for things the user asked for that aren't built yet. Append dated entries, don't rewrite existing ones.
- Memory files live under `/workspace/global/memory/` (writable from main group only). Non-main groups should write to `/workspace/group/memory/` instead.
