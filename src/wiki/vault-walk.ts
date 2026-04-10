/**
 * Shared vault walker + collision blocklist loader.
 *
 * Before this module existed, `lint.ts`, `autofix.ts`, and
 * `migrate-vault.ts` each carried their own copy of a near-identical
 * directory walk plus a byte-identical `DEFAULT_COLLISION_BLOCKLIST`
 * constant. The only real difference is which directories each caller
 * cares about, so we parameterise that and share everything else.
 */

import fs from 'fs';
import path from 'path';

import { readJsonOrDefault } from './fs-util.js';
import { readWikiPage, WikiPageFrontmatter, WikiPageKind } from './markdown.js';
import { vaultPaths } from './paths.js';
import { KIND_TO_DIR } from './resolver.js';

export interface VaultPageRecord {
  filePath: string;
  relativePath: string;
  basename: string;
  dir: string;
  /** Kind declared in the page's own frontmatter (may be undefined). */
  kind: WikiPageKind | undefined;
  /** Kind inferred from the directory the page lives in. */
  expectedKind: WikiPageKind;
  frontmatter: WikiPageFrontmatter;
  body: string;
}

/**
 * Directory → kind entries derived from the resolver's canonical
 * KIND_TO_DIR map. Single source of truth for every vault walker.
 * `report` is excluded — reports/ holds lint's own output and linting
 * it would be circular noise.
 */
export const VAULT_DIRS: { dir: string; kind: WikiPageKind }[] = (
  Object.entries(KIND_TO_DIR) as [WikiPageKind, string][]
)
  .filter(([kind]) => kind !== 'report')
  .map(([kind, dir]) => ({ dir, kind }));

export interface CollectPagesOptions {
  /**
   * Kinds to exclude from the walk. `autofix` uses this to skip
   * `originals/` (immutable verbatim capture).
   */
  excludeKinds?: WikiPageKind[];
}

/**
 * Walk every directory in VAULT_DIRS and return a record per markdown
 * page. Skips per-dir `index.md` (compile-generated) and malformed
 * frontmatter (silently — matches previous behaviour).
 */
export function collectVaultPages(
  vaultPath: string,
  options: CollectPagesOptions = {},
): VaultPageRecord[] {
  const excluded = new Set(options.excludeKinds ?? []);
  const records: VaultPageRecord[] = [];
  for (const { dir, kind: expectedKind } of VAULT_DIRS) {
    if (excluded.has(expectedKind)) continue;
    const dirPath = path.join(vaultPath, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      if (entry.name === 'index.md') continue;
      const filePath = path.join(dirPath, entry.name);
      const parsed = readWikiPage(filePath);
      records.push({
        filePath,
        relativePath: path.relative(vaultPath, filePath),
        basename: path.basename(entry.name, '.md').toLowerCase(),
        dir,
        kind: parsed.frontmatter.pageType,
        expectedKind,
        frontmatter: parsed.frontmatter,
        body: parsed.body,
      });
    }
  }
  return records;
}

// =============================================================================
// Collision blocklist — words that happen to title-case but should not
// trigger unlinked-entity-mention warnings or get autofixed into links.
// =============================================================================

export const DEFAULT_COLLISION_BLOCKLIST: string[] = [
  'The',
  'A',
  'An',
  'And',
  'Or',
  'But',
  'If',
  'Then',
  'When',
  'Where',
  'What',
  'Why',
  'How',
  'Who',
  'With',
  'Without',
  'From',
  'To',
  'In',
  'On',
  'At',
  'By',
  'For',
  'Of',
  'As',
  'Is',
  'Was',
  'Are',
  'Were',
  'Be',
  'Been',
  'Being',
  'Have',
  'Has',
  'Had',
  'Do',
  'Does',
  'Did',
  'Will',
  'Would',
  'Could',
  'Should',
  'May',
  'Might',
  'Can',
  'Cannot',
  'Not',
  'No',
  'Yes',
  'All',
  'Any',
  'Each',
  'Every',
  'Some',
  'Most',
  'More',
  'Less',
  'Very',
  'Just',
  'Only',
  'Also',
  'Even',
  'Still',
  'Yet',
  'Now',
  'Here',
  'There',
  'Today',
  'Yesterday',
  'Tomorrow',
  'Wiki',
  'Source',
  'Note',
  'Goal',
  'Status',
  'Overview',
  'Content',
];

/**
 * Load the user's collision blocklist from
 * `.openclaw-wiki/entity-collision-blocklist.json`, falling back to
 * the built-in defaults. Returns a lowercased set for case-insensitive
 * matching.
 */
export function loadCollisionBlocklist(vaultPath: string): Set<string> {
  const blocklistPath = path.join(
    vaultPaths(vaultPath).stateDir,
    'entity-collision-blocklist.json',
  );
  const data = readJsonOrDefault<{ blocklist: string[] }>(blocklistPath, {
    blocklist: DEFAULT_COLLISION_BLOCKLIST,
  });
  const words = Array.isArray(data.blocklist)
    ? data.blocklist
    : DEFAULT_COLLISION_BLOCKLIST;
  return new Set(words.map((w) => w.toLowerCase()));
}
