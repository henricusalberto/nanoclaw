#!/usr/bin/env node
/**
 * rescue-session.mjs — unstick a Claude Code session JSONL that's hitting
 * "An image in the conversation exceeds the dimension limit for many-image
 * requests (2000px)" on resume.
 *
 * The bug: once a session accumulates 2+ images, Anthropic's API enforces a
 * 2000px-per-dimension cap retroactively on every image in history. The
 * Claude Agent SDK normally downsizes images on Read, but this breaks if
 * any image entered via a path that bypassed the Read resize (screenshots
 * from MCP tools, pre-built content blocks, upload-as-file, older SDKs).
 *
 * The fix: walk the session JSONL, replace every base64 image content
 * block with a short text placeholder. History is preserved, images are
 * forgotten. The session resumes normally on the next run.
 *
 * Recurses into `tool_result.content` so Read-tool-returned images get
 * stripped too (the upstream Python port by ianbmacdonald only checks the
 * top-level message.content array and misses those).
 *
 * Usage:
 *   node scripts/rescue-session.mjs <path-to-jsonl> [--dry-run]
 *
 * For NanoClaw session files, they live at:
 *   data/sessions/<group-folder>/.claude/projects/-workspace-group/*.jsonl
 *
 * Writes atomically via rename. Backs up first as <file>.bak (or .bak.1,
 * .bak.2 if an earlier backup exists).
 */

import fs from 'node:fs';
import path from 'node:path';

const targetPath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!targetPath || targetPath.startsWith('--')) {
  console.error('Usage: rescue-session.mjs <path-to-jsonl> [--dry-run]');
  process.exit(2);
}
if (!fs.existsSync(targetPath)) {
  console.error(`File not found: ${targetPath}`);
  process.exit(2);
}

// Backup with .bak, .bak.1, .bak.2 ... pattern
function nextBackupPath(p) {
  if (!fs.existsSync(`${p}.bak`)) return `${p}.bak`;
  for (let i = 1; i < 1000; i++) {
    if (!fs.existsSync(`${p}.bak.${i}`)) return `${p}.bak.${i}`;
  }
  throw new Error('Too many backups');
}

// Recursively walk a content array (and nested tool_result.content arrays)
// replacing base64 image blocks with text placeholders.
function stripImages(contentArr) {
  if (!Array.isArray(contentArr)) return { out: contentArr, replaced: 0 };
  let replaced = 0;
  const out = contentArr.map((block) => {
    if (!block || typeof block !== 'object') return block;
    if (
      block.type === 'image' &&
      block.source &&
      block.source.type === 'base64'
    ) {
      const chars = (block.source.data || '').length;
      const media = block.source.media_type || 'unknown';
      replaced++;
      return {
        type: 'text',
        text: `[image removed: ${media}, ${chars} chars]`,
      };
    }
    // Recurse into tool_result blocks, which nest their own content array.
    // This is where Read-tool image results live and where the upstream
    // Python port misses them.
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const res = stripImages(block.content);
      replaced += res.replaced;
      return { ...block, content: res.out };
    }
    return block;
  });
  return { out, replaced };
}

const raw = fs.readFileSync(targetPath, 'utf8');
const lines = raw.split('\n');
let totalReplaced = 0;
let linesChanged = 0;

const rewritten = lines.map((line) => {
  if (!line.trim()) return line;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }
  const msgContent = entry.message?.content;
  if (!Array.isArray(msgContent)) return line;
  const { out, replaced } = stripImages(msgContent);
  if (replaced > 0) {
    totalReplaced += replaced;
    linesChanged++;
    entry.message.content = out;
    return JSON.stringify(entry);
  }
  return line;
});

console.log(
  `Found ${totalReplaced} image block(s) across ${linesChanged} line(s) in ${path.basename(targetPath)}`,
);

if (dryRun) {
  console.log('(dry run — no changes written)');
  process.exit(0);
}

if (totalReplaced === 0) {
  console.log('No changes needed.');
  process.exit(0);
}

const backup = nextBackupPath(targetPath);
fs.copyFileSync(targetPath, backup);
console.log(`Backed up to ${backup}`);

const tmpPath = `${targetPath}.tmp-${process.pid}`;
fs.writeFileSync(tmpPath, rewritten.join('\n'));
fs.renameSync(tmpPath, targetPath);

console.log(`Wrote ${targetPath}`);
