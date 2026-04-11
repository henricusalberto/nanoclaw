# Wiki subsystem — next steps

Context for the next Claude session working on `src/wiki/`. The wiki
has shipped Phases 1-5 of the gbrain port plus the hub navigation
layer plus the operations registry plus 914 classified X bookmarks.
What's left is a short list of content-quality improvements, some of
which were flagged during a reference comparison against
kothari-nikunj/llm-wiki, mylife.wiki, and farza's gist.

**This plan covers NanoClaw-side work only.** The Wikipedia-style
web viewer's own backlog lives in `wiki-clone/PLAN.md` and is not
repeated here.

---

## Priority 1 — Anti-cramming lint + split proposals

### The concept

**Anti-cramming** means: a single page isn't allowed to accumulate
unrelated themes. If one page has grown to cover four distinct
topics, the fix isn't shorter prose — it's *splitting* the page into
focused children with the parent kept as a short index.

**Anti-thinning** is the opposite: too many stubs. We already have
anti-thinning in `src/wiki/enrichment.ts::selectThinPages`. Any
load-bearing page (person/company/project/deal) with <3 claims
becomes a Tier 2 enrichment candidate on the next dream cycle.
Nothing to build there.

Cramming detection is the missing half.

### Why it matters on our vault specifically

Measured on 2026-04-11, prose line distribution per page kind
(managed blocks and frontmatter excluded):

| Kind | N | Min | Median | p90 | Max |
|---|---|---|---|---|---|
| concept | 59 | 10 | 17 | **99** | **174** |
| person | 12 | 12 | 20 | **97** | 122 |
| project | 19 | 12 | 18 | **126** | 127 |
| company | 6 | 20 | 30 | **130** | 130 |
| synthesis | 10 | 60 | 74 | 148 | 148 |

There are **13 pages over 100 prose lines**. The worst offenders:

| Lines | Kind | Page | Reason |
|---|---|---|---|
| 174 | concept | `concepts/ecom-product-development.md` | Four distinct methodologies in one page |
| 160 | hub | `home.md` | Expected — managed blocks dominate |
| 148 | synthesis | `syntheses/reviveplus-mar2026.md` | Monthly arc, expected length |
| 143 | concept | `concepts/frameworks.md` | 22 frameworks in one page — really a category |
| 133 | concept | `concepts/nightcap-copy-framework.md` | Mixes copy rules, segment library, page templates |
| 130 | company | `companies/daily-sip.md` | Entire lifecycle in one page |
| 127 | project | `projects/pinterest-system.md` | Architecture + bugs + experiments + decision engine |
| 126 | project | `projects/nightcap.md` | Origin + formula + launches + crisis |
| 122 | person | `people/maurizio-faerber.md` | Recently merged with `maurizio.md`, now double-sized |
| 118 | concept | `concepts/ad-metrics-framework.md` | Diagnostic framework + benchmarks + cases |
| 115 | project | `projects/janus-agent.md` | System design + migration + skills + QMD |
| 110 | concept | `concepts/pinterest-decision-engine.md` | Rules + DB schema + dashboard + optimization |

Clear cramming candidates: `ecom-product-development`, `frameworks`,
`nightcap-copy-framework`, `ad-metrics-framework`,
`pinterest-decision-engine`, `pinterest-system`. Each is really 3-5
focused pages glued together.

### Proposed targets per kind

| Kind | Floor | Target | Warn at |
|---|---|---|---|
| person | 20 | 20-80 | <10 or >100 |
| company | 20 | 20-60 | <10 or >75 |
| project | 30 | 30-80 | <15 or >100 |
| concept | 20 | 20-80 | <10 or >100 |
| deal | 20 | 20-50 | <10 or >65 |
| synthesis | 60 | 60-120 | <30 or >150 |
| hub | — | — | skip — managed blocks |
| original | — | — | skip — verbatim capture |
| source | — | — | skip — extractor output |
| report | — | — | skip — generated |

Counts are **prose lines only**: strip frontmatter, strip managed
blocks via the regex
`/<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g`,
then count lines with non-whitespace content.

### What to build

**Step 1 — lint rule only (no automation).** Add
`page-length-target` to `src/wiki/lint.ts`. Emit warnings at
1.25× ceiling ("cramming risk") and <0.5× floor ("possibly thin").
No errors — warnings only. Hubs, originals, sources, and reports
are exempt.

Expected output on the current vault: ~13 new `cramming` warnings,
zero `thin` warnings (the earlier merge cleanup killed those).

Implementation sketch in `src/wiki/lint.ts`:

```ts
const LENGTH_TARGETS: Partial<Record<WikiPageKind, { floor: number; ceiling: number }>> = {
  person:    { floor: 20, ceiling: 80 },
  company:   { floor: 20, ceiling: 60 },
  project:   { floor: 30, ceiling: 80 },
  concept:   { floor: 20, ceiling: 80 },
  deal:      { floor: 20, ceiling: 50 },
  synthesis: { floor: 60, ceiling: 120 },
};

const MANAGED_BLOCK_RE =
  /<!--\s*openclaw:wiki:[a-z-]+:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:[a-z-]+:end\s*-->/g;

function countProseLines(body: string): number {
  return body
    .replace(MANAGED_BLOCK_RE, '')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

function checkPageLength(page: PageRecord): LintIssue[] {
  const target = LENGTH_TARGETS[page.expectedKind];
  if (!target) return [];
  const lines = countProseLines(page.body);
  const issues: LintIssue[] = [];
  if (lines > target.ceiling * 1.25) {
    issues.push({
      code: 'page-length-cramming',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `page has ${lines} prose lines (target ${target.floor}-${target.ceiling}). Consider splitting into focused children.`,
      context: { lines, floor: target.floor, ceiling: target.ceiling },
    });
  } else if (lines < target.floor * 0.5) {
    issues.push({
      code: 'page-length-thinning',
      severity: 'warning',
      pagePath: page.relativePath,
      message: `page has ${lines} prose lines (target ${target.floor}-${target.ceiling}). Consider enriching or merging.`,
      context: { lines, floor: target.floor, ceiling: target.ceiling },
    });
  }
  return issues;
}
```

Wire into the existing lint walker alongside the other checks. Add
the two new codes to the `LintIssueCode` union at the top of
`lint.ts`.

**Step 2 — dream cycle picks up cramming candidates.** Add to
`src/wiki/enrichment.ts::selectThinPages` (rename or add a sibling
`selectCrammedPages`). A page is a cramming candidate when lint
code `page-length-cramming` fires on it.

**Step 3 — Tier 2 split proposal prompt.** New prompt path in
`src/wiki/tier.ts`. When the candidate's enrichment reason is
`cramming`, Sonnet gets a different prompt:

> You are reviewing a personal wiki page that has grown too long.
> Read the full body below and return a JSON object with:
>
> ```
> {
>   "shouldSplit": boolean,
>   "reason": "why split or why not",
>   "parentSummary": "short replacement body for the parent page (under 40 lines) — keep the intro and a 'See also' list linking to the children",
>   "children": [
>     {
>       "slug": "kebab-case-slug",
>       "title": "Human Title",
>       "kind": "concept | person | project | ...",
>       "body": "full markdown for the new child page",
>       "sourceLines": "rough markdown quote of which section of the parent this came from (for audit)"
>     }
>   ]
> }
> ```
>
> Conservative default: shouldSplit false if the page is a
> legitimately long synthesis or an index. Only propose a split
> when the page contains 2+ clearly unrelated themes.

The split proposal lands as a shadow file at
`.openclaw-wiki/enrichment/<parent-slug>/split-proposal.md` rendered
as markdown with:
- Reason
- Proposed parent rewrite
- N child pages with titles, slugs, and bodies
- A manual-apply note

**Never auto-apply splits.** Require a human-triggered CLI
subcommand:

```
wiki apply-split <parent-slug>
```

which reads the shadow proposal, writes the N children via
`writeWikiPage` (using the resolver to pick a directory per child),
overwrites the parent with `parentSummary`, rewrites every inbound
wikilink that used to point at the parent with section anchors to
the new child pages where applicable, and moves the proposal to
`applied-split-<iso>.md`.

**Step 4 — surface in the wiki-clone viewer.** Already covered by
`wiki-clone/PLAN.md` under "length warnings in the infobox". Not
this session's concern.

### Effort

- Step 1 (lint rule): 1-2 hours
- Step 2 (dream cycle hook): 1 hour
- Step 3 (Tier 2 prompt + shadow writer): 2-3 hours
- Step 4 (apply-split CLI): 3-4 hours

Total: half a day to a full day.

### What not to do

- **Do not auto-split pages.** Structural surgery on load-bearing
  pages is a judgment call. Shadow proposals only.
- **Do not silence the warnings by quietly shortening prose.** The
  signal is the point — it tells you a page outgrew its kind.
- **Do not apply length targets to hubs, originals, sources, or
  reports.** Managed blocks, verbatim quotes, extractor output, and
  generated content have different length economies.
- **Do not raise the warning threshold to suppress current offenders.**
  The 13 crammers are real — if the threshold is wrong it's because
  the targets are wrong, not because the offenders are fine.

---

## Priority 2 — Backlog (from the earlier llm-wiki / mylife / farza comparison)

Ordered by value × effort. Each is independent.

### 2.1 New page kinds: `tensions/`, `philosophies/`, `patterns/`, `decisions/`

From farza's taxonomy. Splits `concepts/` into meaningfully
different buckets:

- **`tensions/`** — unresolved contradictions as living documents.
  The `contradictions` frontmatter field already exists but has
  nowhere to grow. A tension page traces two opposing forces over
  time ("ship fast vs. build to last"; "Dom's methodology vs.
  instinct"; "coaching income vs. product focus") and gets updated
  when new evidence lands.
- **`philosophies/`** — articulated positions and beliefs. Not
  frameworks (those stay in `concepts`), not rules (those go to
  `patterns`). Arguments for a stance.
- **`patterns/`** — recurring behavioral cycles. "I always abandon
  projects at month 3" is a pattern; the page collects instances
  and the recurring structure.
- **`decisions/`** — inflection points with enumerated reasoning.
  Daily Sip → Nightcap pivot on Dec 18, OpenClaw → NanoClaw migration,
  etc. Each is a page with: the decision, the alternatives considered,
  the reasoning, the outcome (filled in later).

Implementation:

1. Add 4 kinds to `WikiPageKind` in `src/wiki/markdown.ts`
2. Add 4 dirs to `KIND_TO_DIR` in `src/wiki/resolver.ts` (e.g.
   `tension: 'tensions'`)
3. Add 4 empty directories to the vault (`mkdir tensions philosophies
   patterns decisions`)
4. Extend `hub-rules.ts` kind-to-hub mapping: tensions → `me`,
   philosophies → `me`, patterns → `playbooks`, decisions →
   `businesses`
5. Migration pass: reclassify some current `concepts/` pages.
   Candidates I'd move:
   - `concepts/lessons-learned.md` → `patterns/lessons-learned.md`
   - `concepts/behavioral-operating-system.md` → `philosophies/`
   - A new `decisions/daily-sip-to-nightcap-pivot.md` extracted
     from `reviveplus-dec2025.md`

Effort: half a day.

### 2.2 Writing-tone lint

Both llm-wiki and farza enforce explicit writing standards. Ours is
in `groups/telegram_wiki-inbox/CLAUDE.md` as instructions to Janus
but isn't enforced as lint. Making it a lint rule gives every new
page AND every enrichment proposal an automatic check.

Five rules to enforce, all severity `warning`:

1. **No em dashes** (`—`) — already in Janus's instructions but
   unchecked.
2. **No AI clichés**: `delve`, `tapestry`, `landscape` (as an
   abstract metaphor), `pivotal`, `fostering`, `garner`,
   `underscore` (as a verb), `vibrant`, `interplay`, `intricate`,
   `crucial`, `showcase`, `genuine`, `deeply`, `truly`, `legendary`,
   `powerful`, `importantly`, `profound`.
3. **Attribution over assertion**: flag unsourced assertion
   phrasing. "X is true" → should be "Dom argued X" or "The Aug 2025
   calls established X". Detected heuristically: sentences starting
   with imperative/declarative claims without a cited source in the
   same paragraph OR an inline `[Source: ...]` tag.
4. **Max 2 direct quotes per article**: count `"..."` blocks longer
   than 20 characters. Warn at 3+.
5. **Themes not chronology**: weaker heuristic. Flag pages where
   >60% of `##` headings are dates (matches `YYYY-\*` or month names
   in headings). These have become diaries instead of theme pages.

Add `writing-standards` lint check to `src/wiki/lint.ts`. Exempt:
- `originals/` (verbatim capture — never rewrite)
- `sources/` (extractor output — not our prose)
- `syntheses/` (intentional monthly arcs, chronology IS the theme)
- `reports/` (generated)
- claim text inside frontmatter (the quoted content may contain
  banned words legitimately)
- code blocks (won't flag `crucial` inside a `` `CrucialError` ``
  class name)

Check the prose body outside frontmatter and outside fenced code.

Effort: 2 hours.

### 2.3 `wiki breakdown` command

Gap detection from the top down. Scans existing articles for named
entities (capitalised phrases ≥2 words) that are mentioned in prose
but don't have wiki pages. Ranks by reference count across the
vault. Creates stubs for the top N.

Different from `candidate-processor.ts`:
- candidate-processor walks `entity-candidates.jsonl` from Telegram
  message scanning — captures new entities from conversation
- breakdown walks existing article bodies — finds entities Janus
  himself mentioned when writing up notes

Implementation:
- New `src/wiki/breakdown.ts` with `findMissingEntities(pages)` and
  `createStubsForMissing(top, vaultPath)`
- CLI subcommand `wiki breakdown [--min-refs N] [--apply]` with
  dry-run by default
- Reuses the entity-extraction regex patterns from
  `entity-scan.ts`

Effort: half a day.

### 2.4 `wiki reorganize` command

LLM pass that reads `_index.md` (or our equivalent, the compile
cache), samples 20 random articles, and returns: "should anything
merge/split? new categories needed? orphans? missing patterns?".
Runs weekly Sunday as a shadow proposal at
`.openclaw-wiki/enrichment/_reorganize/proposed.md`.

Effort: 1 day. Mostly prompt engineering plus the shadow-proposal
plumbing which we already have for tier enrichments.

### 2.5 Source hierarchy + layered absorb

Both llm-wiki and farza process sources strictly in priority order:

1. **Writing** (highest — blog posts, essays, published thinking)
2. **Tweets / structured notes** (medium — well-formed ideas)
3. **Bookmarks** (low — interest signal only, never standalone
   pages)
4. **Messages** (lowest — high noise, selective)

With `/wiki cleanup` runs **between** each layer.

Our current bridge treats everything equivalently. The candidate
processor auto-promoted stub pages from Telegram messages that
should have been absorbed into existing pages instead.

Implementation:
- Add `priority: 1-4` field to each bridge source config in
  `bridge.json`
- `candidate-processor.ts` processes in priority order
- `entity-scan.ts` likewise
- Compile runs autofix + lint between priority bands

Effort: 1 day.

### 2.6 Skill rewrite — stronger "you are a writer" framing

Farza's skill opens with:

> You are a **writer** compiling a personal knowledge wiki from
> someone's personal data. Not a filing clerk. A writer. Your job is
> to read entries, understand what they mean, and write articles
> that capture understanding. The wiki is a map of a mind.
>
> The question is never "where do I put this fact?" It is: **"what
> does this mean, and how does it connect to what I already
> know?"**

Our `container/skills/wiki/SKILL.md` is operational but doesn't
have this vivid framing. Rewrite the opening and the "ingest
discipline" section to match. Janus's quality on auto-claim
generation has been dragging because the skill reads as a filing
job.

Effort: 1 hour.

### 2.7 `wiki query` saved outputs

kothari-nikunj and farza both save query answers to `outputs/` for
future reference. We don't — queries are one-shot in the Telegram
conversation.

Add `wiki query <question>` CLI that writes to
`reports/queries/<date>-<slug>.md` with the question, the answer,
the cited pages, and the prompt used. Cron daily cleanup of queries
older than 30 days.

Effort: 1 hour.

---

## Priority order summary

Order is roughly value × inverse effort. Section numbers
(left column) are stable IDs for the section headings above. The
`Rank` column is the build order I'd actually follow.

| Rank | § | Item | Effort | Value |
|---|---|---|---|---|
| 1 | P1 | **Anti-cramming lint + split proposals** | 0.5-1 day | ★★★ (13 real hits on current vault) |
| 2 | 2.2 | Writing-tone lint (em dashes, AI clichés, quotes, themes-not-chronology) | 2h | ★★ |
| 3 | 2.6 | Skill rewrite — "you are a writer" framing | 1h | ★★ |
| 4 | 2.1 | New kinds: tensions / philosophies / patterns / decisions | 0.5 day | ★★★ |
| 5 | 2.3 | `wiki breakdown` — gap detection from existing articles | 0.5 day | ★★ |
| 6 | 2.5 | Source hierarchy + layered absorb | 1 day | ★★ |
| 7 | 2.4 | `wiki reorganize` weekly structural pass | 1 day | ★ |
| 8 | 2.7 | `wiki query` saved outputs | 1h | ★ |

**If you have half a day:** do rank #1 (anti-cramming lint). This
alone surfaces the 13 crammers in the vault and hands you a list
you can walk.

**If you have a full day:** #1 + #2 + #3 + #8. Three quick wins
plus query-saved-outputs stacked — anti-cramming lint, writing-tone
lint, skill rewrite, query outputs. Together that's ~5 hours and
touches every page in the vault through lint + every spawn of
Janus through the rewritten skill.

**If you have two days:** add #4 (new kinds). That's a taxonomy
change worth doing together with a migration pass that moves a few
current concepts into `tensions/`, `philosophies/`, `patterns/`,
`decisions/`.

**If you have three days:** add #5 (wiki breakdown). Closes the
gap-detection loop from the top down — finds entities mentioned in
articles but without pages, complements the existing candidate
processor which only runs on new captures.

---

## Anti-patterns — don't do these

- **Don't merge this plan with the viewer plan** (`wiki-clone/PLAN.md`).
  Different scope, different session. Viewer work is in the Next.js
  app; this is core NanoClaw TypeScript.
- **Don't add any rule that autonomously splits pages.** Shadow
  proposals only.
- **Don't raise lint thresholds to silence warnings.** The signal is
  the point.
- **Don't implement FTS5 / Postgres / vector search.** The
  `volume-checker.ts` module already tracks when these become
  warranted. Until it says BUILD NOW, don't.
- **Don't add new page kinds without also adding hub routing** for
  them in `src/wiki/hub-rules.ts`. Invisible kinds become orphans.

---

## Reference — the earlier comparison analysis

For why these items exist, see the comparison conversation around
2026-04-11 with kothari-nikunj/llm-wiki, mylife.wiki/naman-ambavi,
and farza's gist at
https://gist.github.com/farzaa/c35ac0cfbeb957788650e36aabea836d.

Things we have that they don't (do NOT remove):

- Structured claims with evidence and confidence
- Live Telegram conversation ingest
- Nightly dream cycle with tier auto-escalation
- Shadow-file review protocol
- Universal source extractors (PDFs, YouTube, web, images, tweets)
- Per-page version history
- Budget ledger per tier
- Hub navigation layer
- Graph index with typed edges
- Operations contract registry
- Compile-time timeline projection
- Volume checker with FTS5 thresholds

These are the moats. Every new feature should strengthen them or
leave them alone.
