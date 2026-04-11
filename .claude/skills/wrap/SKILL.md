---
name: wrap
description: "End-of-session wrap for Claude Code sessions in the NanoClaw repo. Writes a dated memory file to groups/global/memory/ in the OpenClaw-compatible plain-markdown schema that Janus and the daily synth cron already use. Invoke when the user types /wrap or asks to wrap up the session."
---

# Wrap — Claude Code session memory

You are Claude Code running inside the NanoClaw repo (`/Users/kimbehnke/.nanoclaw/nanoclaw/`). When the user types `/wrap` or asks to wrap up the session, capture the session's durable state into the shared NanoClaw memory tree so that:

1. Janus (Telegram-side, in containers) sees it on next wake.
2. The daily synth cron at 23:00 CET rolls it into `groups/global/MEMORY.md`.
3. The wiki bridge absorbs it into wiki source pages on its next run.
4. If the user ever switches back to OpenClaw, the files are already in OpenClaw's native format and location — zero conversion.

This is the Claude Code counterpart to the container `session-wrap` skill that Janus uses. Same schema, same destination, different writer.

## When to write — not just on /wrap

Don't wait for `/wrap` to persist durable facts. Mid-session, whenever any of these happen, write to memory immediately:

- A decision was made that Janus or future-you will need tomorrow ("we're splitting X into Y because Z").
- A non-obvious workaround was discovered (a compiler quirk, a path gotcha, a credential location).
- The user corrected your approach in a way that changes how you should work on future tasks.
- A file, directory, cron, or service moved / was renamed / was deleted.
- A business or system status changed ("Pinterest killfloor raised to €15/day today").

Auto-writing is additive: a mid-session write does not preclude a `/wrap` at session end. If both happen, append to the same day's file rather than creating a duplicate.

## Destination

**Path**: `groups/global/memory/<YYYY-MM-DD>-claude-<topic-slug>.md`

- `<YYYY-MM-DD>` is today's date in **Europe/Berlin** (CET/CEST). Get it via `TZ=Europe/Berlin date +%Y-%m-%d` using the Bash tool.
- `claude-` prefix on the slug flags the file as written by Claude Code (not Janus) — the synth cron doesn't care about the prefix, but it helps when debugging which agent wrote which memory.
- `<topic-slug>` is a short kebab-case descriptor of the session's main theme. Examples: `wiki-memory-unification`, `historical-imessage-import`, `ad-creative-split`. Not `session-wrap` or `general-notes`. Topic-specific.

If the user passes an argument to `/wrap` (e.g. `/wrap wiki memory unification`), use that as the topic. Otherwise infer the topic from what the session actually covered.

**Multiple topics in one session**: write one file per topic. Don't cram unrelated work into one file. Same rule Janus follows.

**Existing file for the same topic today**: append a new session block separated by `---` and a timestamped H2 header (see format below). Never overwrite an existing file.

## File format — plain markdown, no YAML frontmatter

The NanoClaw/OpenClaw memory schema is deliberately plain. No frontmatter, no structured tags, just readable markdown that both humans and the synth cron can parse. See `groups/global/memory/README.md` for the canonical conventions and any existing `groups/global/memory/2026-04-*.md` file for the shape.

Template:

```markdown
# <Topic Title>

## Session <HH:MM> CET — <one-line summary>

### What we worked on
- <bullet>
- <bullet>

### Key decisions
- <decision> — <why>
- <decision> — <why>

### Files touched
- `<path>` — <what changed>
- `<path>` — <what changed>

### Learned
- <non-obvious thing that future-you or Janus will need>
- <non-obvious thing>

### Open threads
- <thing not finished, with enough context to resume>
- <thing not finished>

### Next
- <what should happen next session>
```

Rules:
- **H1 title** is the topic, written once at the top of the file (when first created). On append, do NOT add a new H1 — start with `---` then a new `## Session` block.
- **H2 session block** timestamped in CET, with a one-line summary after the em… wait no em dashes. Use a colon, comma, or period.
- **H3 sections** — omit any that are empty for this session. A section with no bullets is noise.
- **Bullets** are the only format. No paragraphs, no tables (unless the content is genuinely tabular), no code fences longer than 10 lines. Memory files are for facts and decisions, not long-form writing.
- **Be specific**. `"Fixed a bug in the importer"` is bad. `"Fixed iMessage importer SQLite permission regex — macOS returns 'unable to open database file' not 'permission denied' for FDA issues. See src/wiki/ingesters/imessage.ts:150"` is good.
- **File paths with line numbers** — when referencing code, use `path:line` format so it's clickable in editors.
- **No em dashes**. Use commas, colons, or periods. (Per `groups/telegram_wiki-inbox/CLAUDE.md` writing standards.)
- **No AI cliché vocabulary**: delve, tapestry, landscape, pivotal, fostering, garner, underscore, vibrant, interplay, intricate, crucial, showcase, genuine, deeply, truly, legendary, powerful, importantly, profound. Same list Janus uses.
- **Keep it short.** A full session wrap should land between 15 and 60 lines. Longer than 80 lines means the session needed to be two topics, not one.

## Procedure

1. **Figure out today's CET date and current CET time.** Run `TZ=Europe/Berlin date +"%Y-%m-%d %H:%M"` via Bash. Keep both halves.
2. **Decide the topic slug.** Use the user's `/wrap` argument if provided, otherwise infer from session context. Kebab-case, max 40 chars, lowercase.
3. **Check for an existing file** at `groups/global/memory/<date>-claude-<slug>.md`. Read it if present.
4. **Render the new session block** using the template above. Skip sections with nothing to say.
5. **Write the file** via the Write tool (new file) or Edit (append). On append, insert at the end: `\n---\n\n## Session <time> CET — <summary>\n\n...`
6. **Confirm** to the user with one line: `Session wrapped to groups/global/memory/<date>-claude-<slug>.md (<N> sections, <M> lines).`

That's it. Don't re-run builds, don't re-run the compile, don't try to do anything else unless the user asks. `/wrap` is pure capture.

## What `/wrap` does NOT do

- **Does not touch `~/.claude/projects/-Users-kimbehnke--nanoclaw-nanoclaw/memory/`**. That directory is managed by Claude Code's own auto-memory system and holds living typed documents (user profile, feedback rules, project state). It has a different purpose and different schema. The wiki bridge picks those files up separately via the `claude-code-auto-memory` source.
- **Does not update business READMEs.** The container `session-wrap` skill does that for Janus because Janus runs in the main group with write access to `BUSINESSES/<name>/README.md`. Claude Code sessions typically don't touch business state files. If the session did modify a business README, mention the path in the "Files touched" section; don't write the handoff block from the wrap skill itself.
- **Does not run the bridge or compile.** The next scheduled bridge run (or container spawn) will pick up the new memory file automatically. If the user wants it in the wiki immediately, they can run `node dist/wiki/cli.js bridge` themselves.
- **Does not commit.** Memory files under `groups/global/memory/` are tracked in git but committing them is the user's call, not the wrap skill's.

## If you switch back to OpenClaw

The files written by this skill are OpenClaw-compatible by design: same path structure (`memory/YYYY-MM-DD-<topic>.md`), same plain-markdown schema, same synth-cron expectations. To actually route OpenClaw reads at the NanoClaw live tree, do a one-time migration:

```bash
# Verify the frozen OpenClaw copy is a strict subset of the NanoClaw tree
diff -r ~/.openclaw/workspace/memory/ /Users/kimbehnke/.nanoclaw/nanoclaw/groups/global/memory/

# Then replace the frozen copy with a symlink to the live tree
rm -rf ~/.openclaw/workspace/memory
ln -s /Users/kimbehnke/.nanoclaw/nanoclaw/groups/global/memory ~/.openclaw/workspace/memory
rm -f ~/.openclaw/workspace/MEMORY.md
ln -s /Users/kimbehnke/.nanoclaw/nanoclaw/groups/global/MEMORY.md ~/.openclaw/workspace/MEMORY.md
```

After that, OpenClaw reads and writes the same tree NanoClaw does. Do this only when actually switching back; otherwise leave the OpenClaw copy alone as a frozen archive.
