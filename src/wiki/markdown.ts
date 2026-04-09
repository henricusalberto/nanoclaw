/**
 * Wiki markdown utilities — frontmatter parsing, link extraction, managed blocks.
 *
 * Schema deliberately matches OpenClaw's `extensions/memory-wiki/src/markdown.ts`
 * so vaults built by NanoClaw are openable by the OpenClaw CLI without
 * conversion.
 */

import fs from 'fs';
import path from 'path';

// =============================================================================
// Types — match OpenClaw's WikiPageSummary contract.
// =============================================================================

export type WikiPageKind =
  | 'entity'
  | 'concept'
  | 'source'
  | 'synthesis'
  | 'report';

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
// Frontmatter parser — minimal YAML subset, no dependencies.
//
// Supports the constructs NanoClaw and OpenClaw actually use:
//   key: scalar
//   key: "double-quoted scalar"
//   key: 'single-quoted scalar'
//   key: [item, item, item]
//   key:
//     - item
//     - "item with spaces"
//     - "[[wiki-link]]"
//   key: 0.7   (numbers)
//   key: true  (booleans)
//
// Does NOT support nested objects (we use flat schema).
// =============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquoteString(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  // Number
  if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  // Inline array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => unquoteString(s));
  }
  return unquoteString(trimmed);
}

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const match = line.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }
    const [, key, rawValue] = match;
    if (rawValue.trim() === '') {
      // Multiline list — collect indented `- item` lines
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        const itemMatch = next.match(/^\s+-\s+(.*)$/);
        if (!itemMatch) break;
        items.push(unquoteString(itemMatch[1]));
        i++;
      }
      result[key] = items;
    } else {
      result[key] = parseScalar(rawValue);
      i++;
    }
  }
  return result;
}

function escapeYamlScalar(value: string): string {
  // Quote if it contains special characters or starts with a structural marker.
  if (value === '') return '""';
  if (/[:#\[\]{}&*!|>'"%@`,]/.test(value) || /^[\s-]/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function serializeYamlSubset(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === 'string') {
          lines.push(`  - ${escapeYamlScalar(item)}`);
        } else if (typeof item === 'object' && item !== null) {
          // Inline JSON for object items (claims, evidence)
          lines.push(`  - ${JSON.stringify(item)}`);
        } else {
          lines.push(`  - ${String(item)}`);
        }
      }
      continue;
    }
    if (typeof value === 'object') {
      // Inline JSON for nested objects
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    if (typeof value === 'string') {
      lines.push(`${key}: ${escapeYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}: ${String(value)}`);
  }
  return lines.join('\n');
}

// =============================================================================
// Public API
// =============================================================================

export function parseWikiPage(raw: string): ParsedWikiPage {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw, raw };
  }
  const frontmatter = parseYamlSubset(match[1]) as WikiPageFrontmatter;
  const body = match[2] ?? '';
  return { frontmatter, body, raw };
}

export function readWikiPage(filePath: string): ParsedWikiPage {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseWikiPage(raw);
}

export function serializeWikiPage(
  frontmatter: WikiPageFrontmatter,
  body: string,
): string {
  const yaml = serializeYamlSubset(frontmatter as Record<string, unknown>);
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}

export function writeWikiPage(
  filePath: string,
  frontmatter: WikiPageFrontmatter,
  body: string,
): void {
  const content = serializeWikiPage(frontmatter, body);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic write via temp+rename so partial files never appear
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

export function replaceManagedBlock(
  content: string,
  markerName: string,
  newBody: string,
): string {
  const { start, end } = buildManagedBlockMarkers(markerName);
  const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(`${escaped(start)}[\\s\\S]*?${escaped(end)}`);
  const replacement = `${start}\n${newBody.trim()}\n${end}`;
  if (blockRe.test(content)) {
    return content.replace(blockRe, replacement);
  }
  // No existing block — append at the end (with a leading section if appropriate)
  const trimmed = content.replace(/\s+$/, '');
  return `${trimmed}\n\n${replacement}\n`;
}
