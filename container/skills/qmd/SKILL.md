---
name: qmd
description: Search past conversations, memory, and documentation across the indexed corpus. Use when users ask about things mentioned before, past discussions, or need context from history.
allowed-tools: mcp__nanoclaw__qmd_search, mcp__nanoclaw__qmd_get, mcp__nanoclaw__qmd_status, Grep, Glob, Read
---

# QMD - Conversation & Memory Search

QMD indexes ~5,992 markdown documents on the host: groups, businesses, memory, sessions, skills, docs, systems. Use it whenever you need context from past conversations or stored knowledge.

## Tools

NanoClaw exposes three wrapper tools that take simple, flat parameters:

- `mcp__nanoclaw__qmd_search` — search the index
- `mcp__nanoclaw__qmd_get` — retrieve one document by path or docid
- `mcp__nanoclaw__qmd_status` — show index health

The upstream `mcp__qmd__*` tools are intentionally NOT registered here. Their schemas are misleading and the model emits malformed input every call. Use the wrappers — same backend, clean interface.

## qmd_search

Single-query search (most common):
```
qmd_search(query: "rate limiter token bucket")
```

Semantic search (use a natural-language question):
```
qmd_search(query: "how does the rate limiter handle bursts", type: "vec")
```

Two sub-queries for higher recall (lex + vec is the workhorse):
```
qmd_search(
  query: "connection pool timeout",
  type: "lex",
  second_query: "why do database connections time out under load",
  second_type: "vec"
)
```

Scope to specific collections (comma-separated string):
```
qmd_search(query: "Pinterest experiment", collections: "businesses-main,memory-dir-main", limit: 5)
```

Available collections: `groups`, `businesses-main`, `memory-dir-main`, `memory-root-main`, `sessions-main`, `skills-main`, `docs-main`, `systems-main`, `pinterest-main`, `workspace-root`. Omit `collections` to search everything.

### Query types

- **lex** — BM25 keyword search. Fast, exact. Supports `"phrases"` and `-negation`. Default.
- **vec** — Semantic vector search. Pass a natural-language question.
- **hyde** — Hypothetical document. Pass a 50-100 word passage written as if it were the answer. Strongest for nuanced topics.

### Best-recall pattern

For non-trivial questions, combine lex + vec:
```
qmd_search(
  query: "\"connection pool\" timeout -redis",
  type: "lex",
  second_query: "why do database connections time out under load",
  second_type: "vec",
  intent: "performance investigation, not configuration docs"
)
```

`intent` doesn't search on its own — it disambiguates the query and improves snippet selection.

## qmd_get

Fetch one document from search results:
```
qmd_get(file: "memory/2026-04-02.md")
qmd_get(file: "#abc123")
qmd_get(file: "memory/long-doc.md", fromLine: 100, maxLines: 50)
```

## qmd_status

```
qmd_status()
```

## Fallback: direct file search

If the wrappers ever fail, search the workspace directly:

```bash
grep -r "term" /workspace/group/conversations/
ls -lt /workspace/group/conversations/ | head -10
```

Conversations: `/workspace/group/conversations/*.md`. Group memory: `/workspace/group/CLAUDE.md`. Indexed source files (read-only): `/Users/kimbehnke/.openclaw/workspace/`.

## When to use QMD

- User asks "what did we discuss about X"
- User mentions something from a past conversation
- Need context from previous sessions
- Looking up decisions, preferences, or facts mentioned before
- Searching across multiple groups/businesses
