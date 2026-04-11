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

## Step 3 — Append to LEARNINGS.md (when applicable)

If this session produced a durable insight that applies across businesses or would help a future session avoid a mistake, append it to `/workspace/extra/workspace/LEARNINGS.md`. One entry per learning. Format:

```markdown
## YYYY-MM-DD — <short title>
<2-4 sentences>. Include enough context that a future session reading this cold understands the constraint. Link to related files with `path:line` when relevant.
```

Append only. Never rewrite existing entries. If multiple learnings surfaced in one session, write multiple entries under separate headings.

**What counts as a learning**:
- A non-obvious fact about a tool, API, or system that tripped you up
- A pattern the user corrected you on that you should carry forward
- A shortcut or workaround that turned out to work reliably
- A gotcha in the codebase that would mislead a future reader

**What does NOT count**:
- Per-business state (that goes in the business README Handoff block)
- Today's tasks (that goes in the memory file from Step 2)
- Bugs that got fixed (those go in `ERRORS.md`)
- Unbuilt feature requests (those go in `FEATURE_REQUESTS.md`)

Skip this step entirely when nothing durable surfaced. Most sessions don't produce a learning.

## Step 4 — Append to ERRORS.md / FEATURE_REQUESTS.md (when applicable)

Both files also live at `/workspace/extra/workspace/`. Same append-only discipline as LEARNINGS.md.

- **ERRORS.md** — bugs hit this session and the fix that worked. Future sessions search here before debugging the same thing twice.
- **FEATURE_REQUESTS.md** — things the user asked for that you couldn't build yet. Include the ask verbatim, date, and any constraints they mentioned.

Both can be empty for most sessions. Only add entries when the content is real.

## Step 5 — Confirm

Reply: "Session wrapped. [list files updated]"

## Rules

- Use CET for all dates and timestamps
- Topic slug = short descriptor (e.g. `dashboard`, `coaching`, `pipeline`)
- Do not wait for /wrap to write memory mid-session — write immediately when significant events occur
- Memory files live under `/workspace/global/memory/` (writable from main group only). Non-main groups should write to `/workspace/group/memory/` instead.
- LEARNINGS / ERRORS / FEATURE_REQUESTS are shared across all groups and all agents. Both Janus and Claude Code write to the same files.
