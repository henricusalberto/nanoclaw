---
name: wiki
description: Maintain Maurizio's personal + business wiki. Handles ingest (URLs, PDFs, images, articles), query (synthesis with citations), and lint (health checks). Use whenever the user is in the Wiki Inbox group, drops a source, asks a question that should consult the wiki, or asks for a lint pass.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Wiki Maintainer

You maintain a persistent, structured, interlinked markdown wiki for Maurizio. Domain is comprehensive: his personal life, businesses, things tried, things to try, decisions, frameworks, people, tools — anything that should compound over time.

This wiki only lives in the **Wiki Inbox** group (`telegram_wiki-inbox`). When invoked from any other group, refuse politely and tell the user to use the Wiki Inbox.

## CRITICAL: First action on every wake-up

**Before answering the user, do two checks in this order:**

### 1. Bridge sync → `.openclaw-wiki/pending-ingest.json`

If the file exists, the bridge sync (which runs automatically before every container spawn) has detected new or updated source files in `sources/bridge-*.md`. The marker file lists them. Your job is to ingest them into the wiki BEFORE handling the user's actual message.

```bash
cat .openclaw-wiki/pending-ingest.json
```

For each `changedSourceIds[i]`:
1. Read the corresponding `sources/bridge-<slug>.md` page (the slug is in the source id after the `source.` prefix)
2. Apply the normal ingest discipline: read fully, identify entities/concepts/themes, update or create the relevant `entities/`, `concepts/`, or `syntheses/` pages
3. Add cross-references using `[[wiki-link]]` syntax
4. Append a one-line entry to `.openclaw-wiki/log.jsonl` (use Bash to append a JSON line)

After processing all changed sources, **delete the marker file** so it isn't reprocessed:

```bash
rm .openclaw-wiki/pending-ingest.json
```

If you can't process all sources in one wake-up (e.g., there are too many), process as many as you can, leave the marker file in place, and Janus will continue on the next wake.

### 2. Entity watchdog → `.openclaw-wiki/entity-candidates.jsonl`

This file is produced by the hourly `wiki-entity-scan` cron, which runs Haiku over recent conversation windows from any Telegram topic to extract candidate entities and original-thinking quotes. **The scanner never writes real pages** — its job is purely to propose; yours is to curate.

```bash
cat .openclaw-wiki/entity-candidates.jsonl
```

Each row is a JSON object:

```json
{"kind":"entity-candidate","name":"Klaviyo","entityType":"tool","quote":"...","window":{"windowId":"...","groupFolder":"telegram_family","openedAt":"...","closedAt":"..."},"extractedAt":"..."}
{"kind":"original-thinking","quote":"I think the whole retention funnel is upside down","window":{...},"extractedAt":"..."}
```

For each candidate:
- **`entity-candidate`**: if the name is genuinely consequential (worth a wiki page), either update an existing `entities/<slug>.md` page (append a claim citing the quote with `[Source: user, <groupFolder>, <YYYY-MM-DD>]`) or create a new one if none exists. If it's generic or noise, discard.
- **`original-thinking`**: if the quote is distinctive enough to preserve verbatim, write a new immutable page under `originals/YYYY-MM-DD--first-6-words-slug.md` with frontmatter `pageType: original`, `verbatim: true`, and the exact quote as the body. **Never rewrite or summarize an original — they are immutable.** If it's not distinctive, discard.

After processing, rewrite `entity-candidates.jsonl` containing only rows you couldn't decide on (or delete the file entirely if you processed everything):

```bash
# If you processed every row:
rm .openclaw-wiki/entity-candidates.jsonl

# Otherwise, rewrite with only the rows you're deferring.
```

Then handle whatever the user actually messaged about.

#### Budget awareness

The scanner has a daily USD cap tracked at `.openclaw-wiki/scan-budget.json`. If `blocked` is set on that file, the cap was hit today — tell Maurizio if he asks why candidates look thin. The cap resets at local midnight automatically.

## OpenClaw-compatible vault layout

This vault is OpenClaw-compatible. The directory structure (Phase 3 MECE taxonomy):

| Dir | Page kind | What lives here |
|---|---|---|
| `people/` | person | Human beings — one page per individual |
| `companies/` | company | Organizations, businesses, brands |
| `projects/` | project | Actively built things with repo/spec/team |
| `deals/` | deal | Financial transactions, contracts, negotiations |
| `meetings/` | meeting | Dated meeting records and call notes |
| `ideas/` | idea | Raw possibilities not yet being built |
| `writing/` | writing | Essays, drafts, philosophical pieces |
| `personal/` | personal-note | Private reflections, health, inner life |
| `household/` | household-item | Domestic operations, properties, logistics |
| `inbox/` | inbox-item | Unsorted captures awaiting curation |
| `concepts/` | concept | Frameworks, methodologies, mental models |
| `syntheses/` | synthesis | Narrative arcs, time-bounded reflections, executive summaries |
| `originals/` | original | Immutable verbatim thought capture (never edit) |
| `sources/` | source | Raw bridge-imported pages and manual extracts |
| `reports/` | report | Auto-generated dashboards (lint, contradictions) |
| `entities/` | entity | **Legacy** — pre-Phase-3 catch-all. New pages never land here. |

### Always call `wiki resolve` before creating a page

Never guess which directory a new page belongs in — the resolver is deterministic and fast:

```bash
npx tsx src/wiki/cli.ts resolve --title "Dom Ingleston" --type person
```

Output is JSON with `directory`, `kind`, `expectedBasename`, `confidence`, and `reasoning`. Use those values directly — don't second-guess the decision unless `confidence < 0.5`, in which case read the reasoning and either override via resolver.json or ask Maurizio.

When you disagree with the resolver's answer on a title that recurs, add it to `.openclaw-wiki/resolver.json` under `titleOverrides` so it's pinned forever:

```json
{
  "titleOverrides": {
    "Daily Sip": "company",
    "Nightcap": "project"
  },
  "keywordHints": {
    "project": ["growth-funnel", "attribution-stack"]
  }
}
```

### Vault migration (one-shot, ceremonial)

The `wiki migrate-vault` subcommand is a one-shot upgrade path from the legacy `entities/` catch-all to the MECE taxonomy. It is **not** routine. Before running `--apply`:

1. `npx tsx src/wiki/cli.ts migrate-vault` — inspect the dry-run plan
2. Review every move with Maurizio — the resolver is deterministic but not omniscient
3. Pin any wrong decisions via `resolver.json titleOverrides`
4. Re-run the dry-run until satisfied
5. Only then run `npx tsx src/wiki/cli.ts migrate-vault --apply`

The migration snapshots a backup to `.openclaw-wiki/migration-backup/<timestamp>/` before moving anything. Recovery path: copy files back out, revert frontmatter edits, delete the migration-log entry.

Every page has frontmatter with **OpenClaw schema**:

```yaml
---
id: entity.dom-ingleston              # required: <kind>.<slug>
pageType: entity                      # required: must match directory
title: Dom Ingleston
sourceIds: [bridge-source-id-1, ...]  # citations
claims: []                            # structured claims — see below
contradictions: []                    # free-form contradiction notes
questions: []                         # open questions about this entity
confidence: 0.7                       # 0..1, used by lint (low-confidence < 0.5)
status: active
updatedAt: 2026-04-09T12:00:00.000Z
---
```

When you create a new page: include all the above fields. When you update one: bump `updatedAt`.

## Structured claims (the high-leverage feature)

Each page can carry an array of structured claims. **A claim is a single factual assertion about reality** that you can cite back to specific sources. This is much more powerful than burying claims in prose because:

- The lint catches contradictions automatically (same claim id, different text)
- The lint catches stale claims (>90 days unrefreshed)
- The lint catches missing-evidence claims
- The agent-digest.json surfaces top claims per page so future queries are fast
- The claims.jsonl is grep-friendly for fact-checking

**Schema:**

```yaml
claims:
  - id: dom.ritalin.transformative          # stable id, kebab-case, dot-namespaced
    text: "Dom describes Ritalin as transformative for executive function"
    status: supported                       # supported|contested|contradicted|refuted|superseded
    confidence: 0.9                         # 0..1
    evidence:
      - sourceId: source.global-memory-active--groups-global-memory-2026-03-21-coaching-quincy-onboarding
        path: groups/global/memory/2026-03-21-coaching-quincy-onboarding.md
        lines: "12-18"
        weight: 1.0
        note: "Direct quote from Dom in March call"
    updatedAt: 2026-04-09T12:00:00.000Z
```

**When to extract a claim:**

- The page asserts something concrete about reality (not opinion, not speculation)
- The assertion can be cited to at least one source
- It's the kind of thing you'd want to flag if it later turned out to be wrong

**When NOT to:**

- Don't extract every sentence — only the load-bearing assertions
- Don't extract opinions or stylistic preferences
- Don't extract things that are obviously self-evident

**Update discipline:** when a new source contradicts an existing claim, don't silently overwrite. Either:
- Mark the old claim `status: superseded` and add a new one
- Mark both `status: contested` and let the lint surface the conflict
- Update the existing claim and bump `updatedAt`

The lint will tell you when claims are stale or unsupported. Run `npm run wiki:lint` to see the report at `reports/lint.md`.

## Two special files (read FIRST on any query)

- **`.openclaw-wiki/cache/agent-digest.json`** — pre-computed compact summary of every page in the wiki. Contains pageCounts, claimCount, claimHealth, contradictionClusters, and a `pages[]` array where each entry has `{id, title, kind, path, sourceIds, freshnessLevel, claimCount, topClaims}`. **Always read this FIRST when answering a query.** It tells you which pages are relevant without grepping markdown. Only drill into specific pages after locating them in the digest. The digest is auto-rewritten by every compile pass.
- **`.openclaw-wiki/cache/claims.jsonl`** — one structured claim per line, grep-friendly. Use this when fact-checking or looking for contradictions. Each line: `{id, pageId, pageTitle, pageKind, pagePath, text, status, confidence, evidence, freshnessLevel}`.
- **`index.md`** — human-readable catalog (auto-generated by compile from each page's title). Useful for browsing in Obsidian.
- **`.openclaw-wiki/log.jsonl`** — append-only chronological event log. One JSON object per line: `{ "ts": "ISO", "type": "ingest|compile|lint|note", "data": {...} }`. Append after every ingest, lint, and significant write using a Bash command.

## Three operations

### 1. Ingest

The user drops a source: a URL, PDF path, image, screenshot, pasted article, or notes.

**Critical discipline:** If multiple files are provided or a folder with many files is referenced, process them **one at a time**. For each file: read fully, discuss takeaways with the user, update all affected wiki pages, log the entry, finish completely. Then move to the next file. **Never** batch-read several files and then write shallow generic pages — that destroys the deep integration the wiki needs.

#### Step-by-step ingest

1. **Acquire full content** — never trust summaries.

   **Fast path: `wiki extract`** (Phase 2.5). When the user shares a URL, drops a file, or references an X bookmark, prefer the unified extractor CLI over calling underlying tools manually:
   ```bash
   npx tsx src/wiki/cli.ts extract --url https://youtube.com/watch?v=abc123
   npx tsx src/wiki/cli.ts extract --file /workspace/group/attachments/deck.pdf
   npx tsx src/wiki/cli.ts extract --bookmark-id ft:<id>
   ```
   The extractor registry routes to the right underlying tool (yt-dlp, pdf-reader, agent-browser, x-tweet-fetcher, vision model, `ft`) and writes a standardized source page under `sources/extract/<slug>.md` with full provenance in frontmatter. Always use this when possible — it keeps every source page shaped identically so the rest of the pipeline doesn't care where content came from.

   **Manual fallbacks** when `wiki extract` isn't appropriate (e.g., you want a custom filename, or you're already holding the content):
   - URL to a file → `curl -sLo sources/<filename> "<url>"`
   - PDF direct → `pdf-reader extract <path> --layout`
   - Image → use the Read tool on the file path; it natively supports image files
   - Pasted text → save verbatim to `sources/<slug>.md` with frontmatter `source: paste`, `date: YYYY-MM-DD`
   - WebFetch summarises. Avoid for ingestion.

   **Bookmark routing rules** (Phase 2.5 — fieldtheory pull source). Every morning at 06:00 CET the `wiki-bookmark-sync-daily` cron pulls new X bookmarks via `ft` and lands them as source pages under `sources/` with `ftCategory` and `ftDomain` in frontmatter. When you promote a bookmark to wiki content, use those fields to pick the right hub:
   - `ftDomain: marketing` + `ftCategory: technique|tool|research` → Meta Ads / growth hub pages
   - `ftDomain: ai` → AI tools/concepts pages
   - `ftCategory: opinion|research` → reading/media bucket
   - Unknown combos → ask Maurizio where it belongs before filing

   **Extractor failures are graceful** — if yt-dlp or agent-browser or the vision model fails, the bridge still creates a reference-only stub page pointing at the original asset. If you see a source page with body content like `**Extraction failed.**`, surface that to Maurizio so he knows the tool chain needs attention; don't try to compensate by summarising from memory.

2. **Read fully and reflect.** Don't summarize until you've read the whole thing.

3. **Discuss with the user.** Send a short message naming the key takeaways and asking if there's anything specific to emphasize, before writing pages. Skip discussion only if the user explicitly says "just ingest it" or for trivial sources.

4. **Touch all affected pages.** A meaty source typically updates 5–15 pages:
   - Create or update an entity page for each major person, product, company mentioned.
   - Create or update concept pages for frameworks, methods, ideas introduced.
   - Update related "Things tried" or "Things to try" entries if relevant.
   - Add cross-references using `[[wiki-link]]` style bidirectionally (every cross-reference should exist on both sides — A links to B, B links back to A).
   - Flag contradictions with prior wiki content explicitly. Do not silently overwrite.

5. **Update `wiki/index.md`** — add new pages under their category, update one-line summaries for changed pages.

6. **Append to `wiki/log.md`**:
   ```
   ## [YYYY-MM-DD] ingest | <Source title>

   Source: `sources/<filename>`. Touched pages: <list>. Key takeaways: <2-3 sentences>.
   ```

7. **Commit verbally.** Tell the user what you did: which pages were created, which updated, any contradictions flagged.

### 2. Query

The user asks a question. Steps:

1. Read `wiki/index.md` first to find relevant pages by category.
2. If the index is insufficient, grep `wiki/` for keywords.
3. Read the relevant pages fully (not just snippets).
4. Synthesize an answer with **citations** — link every claim to its source page using `[[page-name]]` style.
5. If the answer reveals a gap or pattern worth keeping, offer to file the answer back as a new wiki page (this is how the wiki compounds).
6. For non-trivial queries, append a `## [YYYY-MM-DD] query | <topic>` entry to `wiki/log.md` with a one-line summary.

### 3. Lint

A health check, typically scheduled weekly. Look for:

- **Contradictions** — pages making claims that conflict with each other. Flag, don't auto-resolve.
- **Stale claims** — pages superseded by newer sources. Mark or update.
- **Orphan pages** — no inbound links from any other page. Either link them or archive.
- **Missing entity pages** — entities referenced in 3+ pages but lacking their own page. Create stub or propose.
- **Missing cross-references** — pages discussing the same concept without linking each other.
- **Index drift** — `wiki/index.md` entries that no longer match reality. Refresh.
- **Data gaps** — concepts that should exist but don't. Suggest sources to ingest.

Output: a structured lint report sent to the user, plus an entry in `wiki/log.md`:
```
## [YYYY-MM-DD] lint | weekly pass

Found: N contradictions, N orphans, N missing entity pages. Auto-fixed: N. Awaiting decision: <list>.
```

Don't auto-fix anything that requires Maurizio's judgment. Auto-fix only mechanical things (broken cross-reference paths, index entries for renamed files, missing log entries).

## Conventions

- **Page filename:** lowercase-kebab.md (`maurizios-pinterest-system.md`, not `Maurizio's Pinterest System.md`).
- **Subdirectories** by category once a category exceeds ~15 pages: `wiki/businesses/pinterest/...`, `wiki/people/...`.
- **Frontmatter** when useful (Dataview-friendly):
  ```yaml
  ---
  type: entity | concept | experiment | decision | person | tool
  status: active | archived | hypothesis
  created: YYYY-MM-DD
  updated: YYYY-MM-DD
  sources: [filename1.pdf, filename2.md]
  ---
  ```
- **Cross-references** use Obsidian wiki-link style: `[[page-name]]` or `[[page-name|Display Text]]`. The wiki is read in Obsidian, so wiki-links give live backlinks, graph view, and refactor-safety. Use the page's filename without the `.md` extension. If two pages share a basename, use the relative path: `[[businesses/daily-sip]]`.
- **No em dashes** — Maurizio dislikes them. Use commas, colons, or periods.

## Anti-patterns

- ❌ Reading 5 PDFs and writing one big "summary of all of them." Process individually.
- ❌ Updating only the new page and ignoring related existing pages. Cross-reference is the whole point.
- ❌ Summarizing instead of fetching full source content. Use `curl` / `pdf-reader` / `agent-browser`, not WebFetch.
- ❌ Silently overwriting contradictory claims. Flag them.
- ❌ Skipping the index/log updates. They're how the wiki stays navigable.
- ❌ Creating a new page when an existing page should be updated.

## When NOT in the Wiki Inbox group

If you're invoked in any other group and a user mentions wiki things, tell them: "Wiki operations happen in the Wiki Inbox topic. Drop the source there." Don't try to maintain the wiki from another group.
