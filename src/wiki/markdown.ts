/**
 * Wiki markdown utilities — frontmatter parsing, link extraction, managed
 * blocks. Schema matches OpenClaw's memory-wiki/markdown.ts so vaults are
 * openable by the openclaw CLI without conversion.
 */

import fs from 'fs';
import path from 'path';

import yaml from 'js-yaml';

// =============================================================================
// Types — match OpenClaw's WikiPageSummary contract.
// =============================================================================

export type WikiPageKind =
  | 'entity'
  | 'concept'
  | 'source'
  | 'synthesis'
  | 'report'
  /**
   * Phase 2: verbatim thought capture. Originals are immutable — the
   * Dream Cycle never rewrites them. They live under `wiki/originals/`
   * and preserve the user's own phrasing.
   */
  | 'original'
  /**
   * Phase 3: MECE taxonomy. The generic `entity` kind was a catch-all
   * that hid important distinctions — a person and a company both used
   * to be `entity`. Each new kind lives in its own directory so the
   * resolver can dispatch by shape + type, and lint fails pages placed
   * in the wrong directory. `entity` stays around for round-trip compat
   * with vaults written by older versions.
   */
  | 'person'
  | 'company'
  | 'meeting'
  | 'deal'
  | 'project'
  | 'idea'
  | 'writing'
  | 'personal-note'
  | 'household-item'
  | 'inbox-item';

export interface WikiClaimEvidence {
  sourceId?: string;
  path?: string;
  lines?: string;
  weight?: number;
  note?: string;
  updatedAt?: string;
}

export interface WikiClaim {
  id?: string;
  text: string;
  status?: string;
  confidence?: number;
  evidence: WikiClaimEvidence[];
  updatedAt?: string;
}

export interface WikiPageFrontmatter {
  id?: string;
  pageType?: WikiPageKind;
  title?: string;
  sourceIds?: string[];
  claims?: WikiClaim[];
  contradictions?: string[];
  questions?: string[];
  confidence?: number;
  status?: string;
  updatedAt?: string;
  // Source-page provenance
  sourceType?: string;
  sourcePath?: string;
  bridgeRelativePath?: string;
  bridgeWorkspaceDir?: string;
  bridgeAgentIds?: string[];
  unsafeLocalConfiguredPath?: string;
  unsafeLocalRelativePath?: string;
  ingestedAt?: string;
  // NanoClaw-specific extras (preserved through round-trip but ignored by OpenClaw lint)
  [key: string]: unknown;
}

export interface ParsedWikiPage {
  frontmatter: WikiPageFrontmatter;
  body: string;
  raw: string;
}

// =============================================================================
// Frontmatter — js-yaml for full YAML 1.2 support including nested objects
// in lists (required for the structured `claims:` schema).
// =============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatterYaml(text: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // graceful: malformed frontmatter shouldn't crash readers
  }
  return {};
}

function serializeFrontmatterYaml(obj: Record<string, unknown>): string {
  // Strip undefineds — js-yaml emits "undefined" otherwise.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) clean[k] = v;
  }
  return yaml
    .dump(clean, {
      lineWidth: -1, // never wrap (preserves wikilinks and long titles)
      noRefs: true,
      quotingType: '"',
      forceQuotes: false,
    })
    .trimEnd();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Normalize array fields and claim structure so downstream code doesn't
 * need defensive Array.isArray + claim.evidence checks everywhere.
 */
function normalizeFrontmatter(
  fm: Record<string, unknown>,
): WikiPageFrontmatter {
  const out = { ...fm } as WikiPageFrontmatter;
  for (const key of [
    'sourceIds',
    'contradictions',
    'questions',
    'bridgeAgentIds',
  ] as const) {
    if (!Array.isArray(out[key])) (out as Record<string, unknown>)[key] = [];
  }
  if (!Array.isArray(out.claims)) {
    out.claims = [];
  } else {
    out.claims = out.claims.map((c: unknown) => normalizeClaim(c));
  }
  return out;
}

function normalizeClaim(raw: unknown): WikiClaim {
  if (!raw || typeof raw !== 'object') {
    return { text: String(raw ?? ''), evidence: [] };
  }
  const c = raw as Record<string, unknown>;
  return {
    ...(typeof c.id === 'string' && { id: c.id }),
    text: typeof c.text === 'string' ? c.text : '',
    ...(typeof c.status === 'string' && { status: c.status }),
    ...(typeof c.confidence === 'number' && { confidence: c.confidence }),
    evidence: Array.isArray(c.evidence)
      ? (c.evidence as unknown[]).map((e) => normalizeEvidence(e))
      : [],
    ...(typeof c.updatedAt === 'string' && { updatedAt: c.updatedAt }),
  };
}

function normalizeEvidence(raw: unknown): WikiClaimEvidence {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const e = raw as Record<string, unknown>;
  return {
    ...(typeof e.sourceId === 'string' && { sourceId: e.sourceId }),
    ...(typeof e.path === 'string' && { path: e.path }),
    ...(typeof e.lines === 'string' && { lines: e.lines }),
    ...(typeof e.weight === 'number' && { weight: e.weight }),
    ...(typeof e.note === 'string' && { note: e.note }),
    ...(typeof e.updatedAt === 'string' && { updatedAt: e.updatedAt }),
  };
}

export function parseWikiPage(raw: string): ParsedWikiPage {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw, raw };
  }
  const frontmatter = normalizeFrontmatter(parseFrontmatterYaml(match[1]));
  const body = match[2] ?? '';
  return { frontmatter, body, raw };
}

export function readWikiPage(filePath: string): ParsedWikiPage {
  return parseWikiPage(fs.readFileSync(filePath, 'utf-8'));
}

export function serializeWikiPage(
  frontmatter: WikiPageFrontmatter,
  body: string,
): string {
  const yamlStr = serializeFrontmatterYaml(
    frontmatter as Record<string, unknown>,
  );
  return `---\n${yamlStr}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/**
 * Module-scoped hook for the Phase 5 versions module. Set via
 * `setWriteWikiPageHook` so `markdown.ts` doesn't have to import
 * `versions.ts` (which would form a dependency cycle). The wiki
 * entry point installs the hook on first use.
 */
let writeWikiPageHook:
  | ((params: {
      filePath: string;
      writtenBy?: string;
      reason?: string;
    }) => void)
  | null = null;

export function setWriteWikiPageHook(
  hook:
    | ((params: {
        filePath: string;
        writtenBy?: string;
        reason?: string;
      }) => void)
    | null,
): void {
  writeWikiPageHook = hook;
}

export interface WriteWikiPageOptions {
  /** Free-form actor label for the version snapshot ('janus', 'autofix', ...). */
  writtenBy?: string;
  /** Short reason for the change. */
  reason?: string;
}

export function writeWikiPage(
  filePath: string,
  frontmatter: WikiPageFrontmatter,
  body: string,
  opts: WriteWikiPageOptions = {},
): void {
  if (writeWikiPageHook) {
    try {
      writeWikiPageHook({
        filePath,
        writtenBy: opts.writtenBy,
        reason: opts.reason,
      });
    } catch {
      // Snapshot failures must never block a real write.
    }
  }
  const content = serializeWikiPage(frontmatter, body);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

// =============================================================================
// Wikilink extraction — matches both [[bracket]] and [text](path.md) styles.
// Returns normalized targets (basenames without .md extension).
// =============================================================================

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const MD_LINK_RE = /\[[^\]]*\]\(([^)]+\.md)\)/g;
const RELATED_BLOCK_RE =
  /<!--\s*openclaw:wiki:related:start\s*-->[\s\S]*?<!--\s*openclaw:wiki:related:end\s*-->/g;

export function normalizeLinkTarget(target: string): string {
  // Strip path components — we resolve by basename across the vault
  const noFragment = target.split('#')[0].split('|')[0];
  const basename = path.basename(noFragment, '.md');
  return basename.toLowerCase();
}

export function extractWikiLinks(body: string): string[] {
  // Strip the auto-generated related block before scanning so it doesn't
  // feed back into itself on next compile.
  const cleaned = body.replace(RELATED_BLOCK_RE, '');
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(cleaned)) !== null) {
    links.add(normalizeLinkTarget(m[1]));
  }
  while ((m = MD_LINK_RE.exec(cleaned)) !== null) {
    links.add(normalizeLinkTarget(m[1]));
  }
  return Array.from(links);
}

// =============================================================================
// Managed block helpers — let generated content live inside markers without
// clobbering surrounding human-authored prose.
// =============================================================================

export function buildManagedBlockMarkers(name: string): {
  start: string;
  end: string;
} {
  return {
    start: `<!-- openclaw:wiki:${name}:start -->`,
    end: `<!-- openclaw:wiki:${name}:end -->`,
  };
}

const managedBlockReCache = new Map<string, RegExp>();

export function replaceManagedBlock(
  content: string,
  markerName: string,
  newBody: string,
): string {
  const { start, end } = buildManagedBlockMarkers(markerName);
  let blockRe = managedBlockReCache.get(markerName);
  if (!blockRe) {
    const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    blockRe = new RegExp(`${escaped(start)}[\\s\\S]*?${escaped(end)}`);
    managedBlockReCache.set(markerName, blockRe);
  }
  const replacement = `${start}\n${newBody.trim()}\n${end}`;
  if (blockRe.test(content)) {
    return content.replace(blockRe, replacement);
  }
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n${replacement}\n`;
}
