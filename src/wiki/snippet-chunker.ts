/**
 * Chunk daily memory files into snippet groups for ingestion.
 * Ported from OpenClaw's `extensions/memory-core/src/dreaming-phases.ts`
 * (`buildDailySnippetChunks`, `normalizeDailyHeading`, etc).
 *
 * The point: feed structured chunks to the LLM rather than dumping a whole
 * memory file. Each chunk is grouped under its heading context and capped at
 * a small size so the agent gets dense, citable units.
 */

const MAX_CHUNK_LINES = 4;
const MAX_CHUNK_CHARS = 280;
const MIN_CHUNK_CHARS = 12;

const GENERIC_HEADINGS = new Set([
  'today',
  'yesterday',
  'tomorrow',
  'morning',
  'afternoon',
  'evening',
  'night',
  'notes',
  'note',
  'log',
  'journal',
  'diary',
  'misc',
  'random',
  'other',
  'todo',
  'tasks',
  'agenda',
]);

export interface DailySnippet {
  heading: string | null;
  bodyLines: string[];
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive
}

function normalizeDailyHeading(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/[`*_~]/g, '')
    .trim();
}

function isGenericDailyHeading(heading: string): boolean {
  const norm = heading.toLowerCase().replace(/[^\w]/g, ' ').trim();
  if (GENERIC_HEADINGS.has(norm)) return true;
  // Date-only headings ("April 9", "2026-04-09")
  if (/^\d{4}-\d{2}-\d{2}$/.test(norm)) return true;
  if (/^\w+\s+\d+(\s*,\s*\d{4})?$/.test(norm)) return true;
  return false;
}

function normalizeDailyListMarker(line: string): string {
  // Strip leading bullet/checkbox to keep snippet lines compact
  return line.replace(/^\s*[-*+]\s*(\[[ xX]\]\s*)?/, '');
}

/**
 * Split a markdown body into snippet chunks. Each chunk is at most
 * MAX_CHUNK_LINES lines and MAX_CHUNK_CHARS characters, grouped by the
 * nearest non-generic heading above it.
 */
export function buildDailySnippetChunks(body: string): DailySnippet[] {
  const lines = body.split(/\r?\n/);
  const snippets: DailySnippet[] = [];

  let currentHeading: string | null = null;
  let currentChunkLines: string[] = [];
  let currentChunkStartLine = 0;
  let currentChunkChars = 0;

  const flushChunk = (endLine: number) => {
    if (currentChunkLines.length === 0) return;
    const text = currentChunkLines.join('\n').trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      snippets.push({
        heading: currentHeading,
        bodyLines: [...currentChunkLines],
        startLine: currentChunkStartLine,
        endLine,
      });
    }
    currentChunkLines = [];
    currentChunkChars = 0;
    currentChunkStartLine = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Heading line
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      flushChunk(lineNum - 1);
      const headingText = normalizeDailyHeading(headingMatch[2]);
      currentHeading = isGenericDailyHeading(headingText) ? null : headingText;
      continue;
    }

    // Skip blank lines but use them as chunk separators
    if (line.trim() === '') {
      flushChunk(lineNum - 1);
      continue;
    }

    // Skip horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      flushChunk(lineNum - 1);
      continue;
    }

    const normalized = normalizeDailyListMarker(line);
    const lineLength = normalized.length;

    // Start new chunk if this would overflow either dimension
    if (
      currentChunkLines.length > 0 &&
      (currentChunkLines.length >= MAX_CHUNK_LINES ||
        currentChunkChars + lineLength > MAX_CHUNK_CHARS)
    ) {
      flushChunk(lineNum - 1);
    }

    if (currentChunkLines.length === 0) {
      currentChunkStartLine = lineNum;
    }
    currentChunkLines.push(normalized);
    currentChunkChars += lineLength;
  }

  flushChunk(lines.length);
  return snippets;
}

/**
 * Render a snippet as a markdown bullet with heading context.
 */
export function renderSnippet(snippet: DailySnippet): string {
  const heading = snippet.heading ? `**${snippet.heading}** — ` : '';
  const body = snippet.bodyLines.join(' ').trim();
  return `- ${heading}${body}`;
}
