/**
 * Compile-time hub projection.
 *
 * Hubs are human-facing landing pages, one per life domain. Their
 * bodies are almost entirely managed blocks — the only hand-written
 * part is the 2-sentence intro above the first block.
 *
 * For each page in the vault with `hub: <name>` in frontmatter, this
 * module groups them by hub and rewrites five managed blocks per hub
 * page on every compile:
 *
 *   - hub-concepts    → concept/playbook pages tagged to this hub
 *   - hub-entities    → project/company/person/deal pages tagged to this hub
 *   - hub-try         → bookmark source pages tagged to this hub, sorted by
 *                       hubPriority desc (top 20)
 *   - hub-questions   → open-status claims on any page tagged to this hub
 *   - hub-recent      → pages tagged to this hub that were written in the
 *                       last 7 days (sorted by updatedAt desc)
 *
 * Hubs are discovered by walking `hubs/` (plus the vault-root `home.md`
 * if it exists and declares `pageType: hub`). Any hub page whose slug
 * has no matching `hub: <slug>` pages ends up with empty managed blocks,
 * which is fine — it signals "this hub isn't populated yet."
 *
 * Mirrors `timeline-projection.ts` for write discipline: managed-block
 * rewrites skip version snapshots to avoid write amplification, and
 * the in-memory `parsedByPath` cache is kept coherent so later compile
 * steps see the post-projection body.
 */

import fs from 'fs';
import path from 'path';

import {
  ParsedWikiPage,
  readWikiPage,
  replaceManagedBlock,
  WikiPageKind,
  writeWikiPage,
} from './markdown.js';
import { VaultPageRecord } from './vault-walk.js';

/**
 * The home dashboard is a special hub slug — it aggregates content
 * from every other hub rather than filtering to pages tagged
 * `hub: home`. Pages never carry that tag; the dashboard just
 * pulls the union.
 */
const HOME_SLUG = 'home';

export interface ProjectHubsResult {
  hubPagesFound: number;
  hubPagesRewritten: number;
  conceptsLinked: number;
  entitiesLinked: number;
  thingsToTryLinked: number;
  openQuestionsLinked: number;
  recentChangesLinked: number;
  durationMs: number;
}

export interface ProjectHubsOptions {
  /** Optional shared parsed cache (same contract as timeline-projection). */
  parsedByPath?: Map<string, ParsedWikiPage>;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

const CONCEPT_KINDS = new Set<WikiPageKind>(['concept', 'synthesis']);
const ENTITY_KINDS = new Set<WikiPageKind>([
  'person',
  'company',
  'project',
  'deal',
  'entity',
]);

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOP_THINGS_TO_TRY = 20;
/**
 * Cap on how many bookmarks appear inside each section-scoped "Things
 * to try" block. Chosen so a Meta Ads page with 4 sub-sections still
 * renders under 50 total bookmarks on screen (~12 per section) without
 * overwhelming the reader.
 */
const TOP_SECTION_TRY = 12;

export function projectHubs(
  vaultPath: string,
  pages: VaultPageRecord[],
  opts: ProjectHubsOptions = {},
): ProjectHubsResult {
  const startedAt = Date.now();
  const result: ProjectHubsResult = {
    hubPagesFound: 0,
    hubPagesRewritten: 0,
    conceptsLinked: 0,
    entitiesLinked: 0,
    thingsToTryLinked: 0,
    openQuestionsLinked: 0,
    recentChangesLinked: 0,
    durationMs: 0,
  };

  const now = opts.now ?? new Date();
  const hubPages = collectHubPages(vaultPath, pages);
  result.hubPagesFound = hubPages.length;

  // Index the rest of the vault once, grouped by hub slug.
  const byHub = indexPagesByHub(pages);

  for (const hubPage of hubPages) {
    const hubSlug = hubSlugFor(hubPage);
    if (!hubSlug) continue;

    // Home aggregates everything. Other hubs filter by tag.
    const members: VaultPageRecord[] =
      hubSlug === HOME_SLUG
        ? allTaggedPages(byHub)
        : (byHub.get(hubSlug) ?? []);

    const concepts = members
      .filter((p) => p.kind && CONCEPT_KINDS.has(p.kind))
      .sort(byConfidenceDesc);
    const entities = members
      .filter((p) => p.kind && ENTITY_KINDS.has(p.kind))
      .sort(byRecencyDesc);
    const thingsToTry = members
      .filter((p) => p.kind === 'source')
      .sort(byHubPriorityDesc)
      .slice(0, TOP_THINGS_TO_TRY);
    const openQuestions = collectOpenQuestions(members);
    const recent = members
      .filter((p) => isRecent(p, now))
      .sort(byRecencyDesc)
      .slice(0, 15);

    const blocks: Array<[string, string]> = [
      ['hub-concepts', renderConcepts(concepts)],
      ['hub-entities', renderEntities(entities)],
      ['hub-try', renderThingsToTry(thingsToTry)],
      ['hub-questions', renderOpenQuestions(openQuestions)],
      ['hub-recent', renderRecent(recent)],
    ];

    // Pull the latest parsed body (post-related, post-timeline) from the
    // shared cache when available.
    const parsed =
      opts.parsedByPath?.get(hubPage.filePath) ??
      readWikiPage(hubPage.filePath);

    // Phase 6: section-scoped managed blocks. When a hub page declares
    // H3 sub-headers inside its `## Core knowledge` or `## Things to try`
    // sections, compile also rewrites managed blocks named
    // `section-pages:<slug>` and `section-try:<slug>`. Members are
    // filtered by the `hubSection` frontmatter field. A safety catch-all
    // named `section-pages:everything-else` / `section-try:everything-else`
    // receives anything tagged to this hub but without a hubSection.
    const sectionSlugs = parseDeclaredSectionSlugs(parsed.body);
    const sectionBlocks: Array<[string, string]> = [];
    if (sectionSlugs.size > 0) {
      const taggedPages = members.filter(
        (p) => p.kind && !CONCEPT_KINDS.has(p.kind) && p.kind !== 'source',
      );
      const untaggedConcepts: VaultPageRecord[] = [];
      const untaggedTry: VaultPageRecord[] = [];
      const conceptsBySection = new Map<string, VaultPageRecord[]>();
      const tryBySection = new Map<string, VaultPageRecord[]>();

      for (const p of concepts) {
        const s = frontmatterSectionSlug(p);
        if (s && sectionSlugs.has(s)) {
          pushToMap(conceptsBySection, s, p);
        } else {
          untaggedConcepts.push(p);
        }
      }
      // Entities (people, companies, projects, deals) follow the same
      // section routing so "Core knowledge" can also host domain-relevant
      // entities.
      for (const p of taggedPages) {
        const s = frontmatterSectionSlug(p);
        if (s && sectionSlugs.has(s)) {
          pushToMap(conceptsBySection, s, p);
        }
        // untagged entities stay in the hub-entities block above —
        // they're not the same shape as concept fallbacks
      }
      // Bookmarks route into try-section buckets based on classifier
      // decisions. The generic hub-try block above caps at 20 across
      // the whole hub; section-scoped try blocks cap at
      // TOP_SECTION_TRY each.
      const allBookmarks = members.filter((p) => p.kind === 'source');
      for (const p of allBookmarks) {
        const s = frontmatterSectionSlug(p);
        if (s && sectionSlugs.has(s)) {
          pushToMap(tryBySection, s, p);
        } else {
          untaggedTry.push(p);
        }
      }

      for (const slug of sectionSlugs) {
        const pagesBlockName = `section-pages:${slug}`;
        const tryBlockName = `section-try:${slug}`;
        if (hasManagedBlock(parsed.body, pagesBlockName)) {
          const sectionPages = (conceptsBySection.get(slug) ?? []).sort(
            byConfidenceDesc,
          );
          sectionBlocks.push([pagesBlockName, renderConcepts(sectionPages)]);
        }
        if (hasManagedBlock(parsed.body, tryBlockName)) {
          const sectionTry = (tryBySection.get(slug) ?? [])
            .sort(byHubPriorityDesc)
            .slice(0, TOP_SECTION_TRY);
          sectionBlocks.push([tryBlockName, renderThingsToTry(sectionTry)]);
        }
      }

      // Catch-all "everything-else" buckets for pages/bookmarks tagged
      // to this hub but without a hubSection. Only rendered if the hub
      // page declares the catch-all managed block.
      if (hasManagedBlock(parsed.body, 'section-pages:everything-else')) {
        sectionBlocks.push([
          'section-pages:everything-else',
          renderConcepts(untaggedConcepts.sort(byConfidenceDesc)),
        ]);
      }
      if (hasManagedBlock(parsed.body, 'section-try:everything-else')) {
        sectionBlocks.push([
          'section-try:everything-else',
          renderThingsToTry(
            untaggedTry.sort(byHubPriorityDesc).slice(0, TOP_SECTION_TRY),
          ),
        ]);
      }
    }

    // Only rewrite blocks the hub template actually declares. This
    // prevents `home.md` — which has a smaller block set — from
    // getting irrelevant blocks appended at the bottom.
    let newBody = parsed.body;
    for (const [name, body] of [...blocks, ...sectionBlocks]) {
      if (!hasManagedBlock(newBody, name)) continue;
      newBody = replaceManagedBlock(newBody, name, body);
    }

    if (newBody === parsed.body) continue;

    writeWikiPage(hubPage.filePath, parsed.frontmatter, newBody, {
      writtenBy: 'compile',
      reason: 'hub projection',
      skipSnapshot: true,
    });

    if (opts.parsedByPath) {
      opts.parsedByPath.set(hubPage.filePath, {
        frontmatter: parsed.frontmatter,
        body: newBody,
        raw: parsed.raw,
      });
    }

    result.hubPagesRewritten++;
    result.conceptsLinked += concepts.length;
    result.entitiesLinked += entities.length;
    result.thingsToTryLinked += thingsToTry.length;
    result.openQuestionsLinked += openQuestions.length;
    result.recentChangesLinked += recent.length;
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}

// =============================================================================
// Hub page discovery
// =============================================================================

/**
 * A hub page is any page whose `pageType` is 'hub'. The normal vault
 * walker skips files in the vault root because VAULT_DIRS only lists
 * subdirectories, so we also pick up `home.md` directly from disk if
 * it exists and declares itself a hub.
 */
function collectHubPages(
  vaultPath: string,
  pages: VaultPageRecord[],
): VaultPageRecord[] {
  const hubs = pages.filter((p) => p.kind === 'hub');
  const homePath = path.join(vaultPath, 'home.md');
  if (fs.existsSync(homePath) && !hubs.some((p) => p.filePath === homePath)) {
    try {
      const parsed = readWikiPage(homePath);
      if (parsed.frontmatter.pageType === 'hub') {
        hubs.push({
          filePath: homePath,
          relativePath: 'home.md',
          basename: 'home',
          dir: '.',
          kind: 'hub',
          expectedKind: 'hub',
          frontmatter: parsed.frontmatter,
          body: parsed.body,
        });
      }
    } catch {
      // Malformed home.md — skip silently, same policy as vault-walk.
    }
  }
  return hubs;
}

/**
 * A hub page's slug is either its explicit `hub:` frontmatter
 * (so `home.md` can declare `hub: home`) or its basename as a fallback.
 */
function hubSlugFor(page: VaultPageRecord): string | null {
  const explicit = page.frontmatter.hub;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return page.basename || null;
}

function indexPagesByHub(
  pages: VaultPageRecord[],
): Map<string, VaultPageRecord[]> {
  const byHub = new Map<string, VaultPageRecord[]>();
  for (const page of pages) {
    if (page.kind === 'hub') continue;
    const hub = page.frontmatter.hub;
    if (typeof hub !== 'string' || hub.trim().length === 0) continue;
    const key = hub.trim();
    const bucket = byHub.get(key);
    if (bucket) bucket.push(page);
    else byHub.set(key, [page]);
  }
  return byHub;
}

function allTaggedPages(
  byHub: Map<string, VaultPageRecord[]>,
): VaultPageRecord[] {
  const out: VaultPageRecord[] = [];
  for (const bucket of byHub.values()) out.push(...bucket);
  return out;
}

function hasManagedBlock(body: string, markerName: string): boolean {
  return body.includes(`openclaw:wiki:${markerName}:start`);
}

/**
 * Parse the set of section-pages:*, section-try:* managed block markers
 * declared in a hub page body. Returns the section slugs (without the
 * `section-pages:` / `section-try:` prefix, without `:start` / `:end`).
 * The catch-all `everything-else` slug is intentionally included here so
 * the filter loop considers it alongside named sections.
 */
function parseDeclaredSectionSlugs(body: string): Set<string> {
  const slugs = new Set<string>();
  const re = /openclaw:wiki:section-(?:pages|try):([a-z0-9-]+):start/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    slugs.add(m[1]);
  }
  slugs.delete('everything-else'); // handled separately
  return slugs;
}

/** Normalise a frontmatter `hubSection` value to a slug comparable to
 *  the one parsed out of managed block markers. */
function frontmatterSectionSlug(page: VaultPageRecord): string | null {
  const raw = page.frontmatter.hubSection;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed.replace(/\s+/g, '-');
}

function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

// =============================================================================
// Sorting helpers
// =============================================================================

function byConfidenceDesc(a: VaultPageRecord, b: VaultPageRecord): number {
  const ca =
    typeof a.frontmatter.confidence === 'number' ? a.frontmatter.confidence : 0;
  const cb =
    typeof b.frontmatter.confidence === 'number' ? b.frontmatter.confidence : 0;
  if (cb !== ca) return cb - ca;
  return a.basename.localeCompare(b.basename);
}

function byRecencyDesc(a: VaultPageRecord, b: VaultPageRecord): number {
  const ua =
    typeof a.frontmatter.updatedAt === 'string' ? a.frontmatter.updatedAt : '';
  const ub =
    typeof b.frontmatter.updatedAt === 'string' ? b.frontmatter.updatedAt : '';
  if (ub !== ua) return ub.localeCompare(ua);
  return a.basename.localeCompare(b.basename);
}

function byHubPriorityDesc(a: VaultPageRecord, b: VaultPageRecord): number {
  const pa =
    typeof a.frontmatter.hubPriority === 'number'
      ? a.frontmatter.hubPriority
      : 0;
  const pb =
    typeof b.frontmatter.hubPriority === 'number'
      ? b.frontmatter.hubPriority
      : 0;
  if (pb !== pa) return pb - pa;
  return byRecencyDesc(a, b);
}

function isRecent(page: VaultPageRecord, now: Date): boolean {
  const ua =
    typeof page.frontmatter.updatedAt === 'string'
      ? page.frontmatter.updatedAt
      : '';
  if (!ua) return false;
  const t = Date.parse(ua);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t <= RECENT_WINDOW_MS;
}

interface OpenQuestionEntry {
  page: VaultPageRecord;
  text: string;
  claimId?: string;
}

function collectOpenQuestions(members: VaultPageRecord[]): OpenQuestionEntry[] {
  const out: OpenQuestionEntry[] = [];
  for (const page of members) {
    const claims = Array.isArray(page.frontmatter.claims)
      ? page.frontmatter.claims
      : [];
    for (const c of claims) {
      if (c.status === 'open') {
        out.push({ page, text: c.text, claimId: c.id });
      }
    }
    const questions = Array.isArray(page.frontmatter.questions)
      ? (page.frontmatter.questions as string[])
      : [];
    for (const q of questions) {
      if (typeof q === 'string' && q.trim().length > 0) {
        out.push({ page, text: q });
      }
    }
  }
  return out;
}

// =============================================================================
// Renderers — every block is sanitised markdown with stable ordering so
// idempotent compile passes produce byte-identical bodies.
// =============================================================================

function renderConcepts(pages: VaultPageRecord[]): string {
  if (pages.length === 0) {
    return '_No concepts tagged to this hub yet._\n';
  }
  const lines: string[] = [];
  for (const p of pages) {
    const title = (p.frontmatter.title as string | undefined) || p.basename;
    lines.push(`- [[${p.basename}|${title}]]`);
  }
  return lines.join('\n') + '\n';
}

function renderEntities(pages: VaultPageRecord[]): string {
  if (pages.length === 0) {
    return '_No projects, companies, or people tagged to this hub yet._\n';
  }
  // Group by kind so you see "People" / "Projects" / "Companies" clusters.
  const byKind = new Map<string, VaultPageRecord[]>();
  for (const p of pages) {
    const k = p.kind || 'other';
    const bucket = byKind.get(k);
    if (bucket) bucket.push(p);
    else byKind.set(k, [p]);
  }
  const kindOrder: WikiPageKind[] = [
    'project',
    'company',
    'deal',
    'person',
    'entity',
  ];
  const kindLabels: Record<string, string> = {
    project: 'Projects',
    company: 'Companies',
    deal: 'Deals',
    person: 'People',
    entity: 'Entities',
  };
  const lines: string[] = [];
  for (const kind of kindOrder) {
    const bucket = byKind.get(kind);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`**${kindLabels[kind] ?? capitalise(kind) + 's'}**`);
    for (const p of bucket) {
      const title = (p.frontmatter.title as string | undefined) || p.basename;
      lines.push(`- [[${p.basename}|${title}]]`);
    }
    lines.push('');
  }
  return lines.join('\n').trim() + '\n';
}

function renderThingsToTry(pages: VaultPageRecord[]): string {
  if (pages.length === 0) {
    return '_No bookmarks classified to this hub yet. Add an X bookmark via fieldtheory or ingest a source; the nightly classifier routes them here._\n';
  }
  const lines: string[] = [];
  for (const p of pages) {
    const oneLiner =
      (p.frontmatter.hubOneLiner as string | undefined) ||
      (p.frontmatter.title as string | undefined) ||
      p.basename;
    // Thin bookmark-source pages keep their original URL in metadata —
    // link back to the bridge source page so the raw tweet is one click away.
    lines.push(`- [[${p.basename}|${oneLiner}]]`);
  }
  return lines.join('\n') + '\n';
}

function renderOpenQuestions(entries: OpenQuestionEntry[]): string {
  if (entries.length === 0) {
    return '_No open questions on pages tagged to this hub._\n';
  }
  const lines: string[] = [];
  for (const e of entries.slice(0, 20)) {
    const title =
      (e.page.frontmatter.title as string | undefined) || e.page.basename;
    lines.push(`- ${e.text} — [[${e.page.basename}|${title}]]`);
  }
  return lines.join('\n') + '\n';
}

function renderRecent(pages: VaultPageRecord[]): string {
  if (pages.length === 0) {
    return '_No changes in the last 7 days._\n';
  }
  const lines: string[] = [];
  for (const p of pages) {
    const title = (p.frontmatter.title as string | undefined) || p.basename;
    const date =
      typeof p.frontmatter.updatedAt === 'string'
        ? p.frontmatter.updatedAt.slice(0, 10)
        : '';
    lines.push(`- ${date} — [[${p.basename}|${title}]]`);
  }
  return lines.join('\n') + '\n';
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
