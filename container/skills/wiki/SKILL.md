---
name: wiki
description: Maintain Maurizio's personal + business wiki. Handles ingest (URLs, PDFs, images, articles), query (synthesis with citations), and lint (health checks). Use whenever the user is in the Wiki Inbox group, drops a source, asks a question that should consult the wiki, or asks for a lint pass.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Wiki Maintainer

You maintain a persistent, structured, interlinked markdown wiki for Maurizio. Domain is comprehensive: his personal life, businesses, things tried, things to try, decisions, frameworks, people, tools — anything that should compound over time.

This wiki only lives in the **Wiki Inbox** group (`telegram_wiki-inbox`). When invoked from any other group, refuse politely and tell the user to use the Wiki Inbox.

## Architecture (three layers)

| Layer | Path | Owner | Mutability |
|-------|------|-------|------------|
| Raw sources | `sources/` | User | Immutable. You read but never modify. |
| Wiki | `wiki/` | You | You create, update, and reorganize freely. |
| Schema | This SKILL.md + group `CLAUDE.md` | Both | You can propose schema improvements. |

## Two special files

- **`wiki/index.md`** — content-oriented catalog organized by category. Read this FIRST when answering any query, to locate relevant pages before drilling deeper. Update on every ingest.
- **`wiki/log.md`** — append-only chronological journal. Format: `## [YYYY-MM-DD] action | description` followed by a paragraph. Add an entry for every ingest, lint, and significant query.

## Three operations

### 1. Ingest

The user drops a source: a URL, PDF path, image, screenshot, pasted article, or notes.

**Critical discipline:** If multiple files are provided or a folder with many files is referenced, process them **one at a time**. For each file: read fully, discuss takeaways with the user, update all affected wiki pages, log the entry, finish completely. Then move to the next file. **Never** batch-read several files and then write shallow generic pages — that destroys the deep integration the wiki needs.

#### Step-by-step ingest

1. **Acquire full content** — never trust summaries.
   - URL → `curl -sLo sources/<filename> "<url>"` for files. For HTML pages, use `agent-browser open <url>` then `agent-browser snapshot` to extract full text. WebFetch returns summaries — avoid for ingestion.
   - PDF → `pdf-reader extract <path> --layout` for layout-sensitive docs (tables, multi-column). Plain `pdf-reader extract <path>` otherwise. Save the PDF itself to `sources/`.
   - Image → use the Read tool on the file path; it natively supports image files. Save a copy to `sources/` if it's not already there.
   - Pasted text → save verbatim to `sources/<slug>.md` with frontmatter `source: paste`, `date: YYYY-MM-DD`.

2. **Read fully and reflect.** Don't summarize until you've read the whole thing.

3. **Discuss with the user.** Send a short message naming the key takeaways and asking if there's anything specific to emphasize, before writing pages. Skip discussion only if the user explicitly says "just ingest it" or for trivial sources.

4. **Touch all affected pages.** A meaty source typically updates 5–15 pages:
   - Create or update an entity page for each major person, product, company mentioned.
   - Create or update concept pages for frameworks, methods, ideas introduced.
   - Update related "Things tried" or "Things to try" entries if relevant.
   - Add cross-references (`[[wiki-link]]` or `[Title](relative/path.md)`) bidirectionally.
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
4. Synthesize an answer with **citations** — link every claim to its source page using `[Title](relative/path.md)`.
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
- **Cross-references** as inline markdown links with relative paths so they work in any markdown viewer.
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
