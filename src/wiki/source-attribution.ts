/**
 * Source attribution format — parse, validate, render.
 *
 * Format: `[Source: who, context, YYYY-MM-DD HH:MM TZ]`
 *
 * Examples:
 *   [Source: User, direct message, 2026-04-10 14:32 CET]
 *   [Source: Dom, call #87, 2026-03-22 15:00 PT]
 *   [Source: email from Sarah, Q2 deck, 2026-04-05 14:30 CET]
 *   [Source: Meeting notes "Team Sync", 2026-04-03 12:11 CET]
 *   [Source: bridge-global-memory-active--2026-04-09, 2026-04-09]
 *
 * The `who` and `context` fields may contain any chars except commas
 * (commas are the delimiter). Date is required. Time is optional but
 * strongly preferred. Timezone is optional.
 */

import { WikiClaim, WikiClaimEvidence } from './markdown.js';

export interface SourceAttribution {
  /** Who said or authored it (user, name, system, bridge id, etc) */
  who: string;
  /** Context: channel, meeting name, document title, etc */
  context: string;
  /** ISO date `YYYY-MM-DD` */
  date: string;
  /** Optional time `HH:MM` */
  time?: string;
  /** Optional timezone abbreviation, e.g. CET, PT, UTC */
  tz?: string;
}

/**
 * Match a `[Source: ...]` block. Captures the inner text between the
 * colon and the closing bracket; parsing the inner fields is done
 * separately by `parseAttributionInner` so we can handle the 2-field
 * shorthand `[Source: who, date]` and the 3-field form
 * `[Source: who, context, date]` with the same regex.
 */
export const SOURCE_ATTRIBUTION_RE = /\[Source:\s*([^\]]+?)\s*\]/;
// Global variant reused by extractAllSourceAttributions so each call
// gets a fresh iterator — we can't use SOURCE_ATTRIBUTION_RE directly
// because it's shared and has no /g flag.
const SOURCE_ATTRIBUTION_RE_SOURCE = SOURCE_ATTRIBUTION_RE.source;

const DATE_RE =
  /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?(?:\s+([A-Z]{2,5}))?$/;

/**
 * Parse the comma-separated fields inside a Source attribution. Returns
 * null if no parseable date is found.
 *
 * Algorithm: split on commas, scan from the right for the first field
 * that starts with a date pattern. That field holds date/time/tz; every
 * earlier field belongs to who/context.
 *
 * - 1 earlier field  → who, (no explicit context)
 * - 2 earlier fields → who, context
 * - 3+ earlier fields → who = first, context = join(middle, ', ')
 */
function parseAttributionInner(inner: string): SourceAttribution | null {
  const parts = inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  let dateIdx = -1;
  let dateMatch: RegExpMatchArray | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const m = parts[i].match(DATE_RE);
    if (m) {
      dateIdx = i;
      dateMatch = m;
      break;
    }
  }
  if (dateIdx < 1 || !dateMatch) return null;

  const whoContextParts = parts.slice(0, dateIdx);
  let who: string;
  let context: string;
  if (whoContextParts.length === 1) {
    who = whoContextParts[0];
    context = '';
  } else {
    who = whoContextParts[0];
    context = whoContextParts.slice(1).join(', ');
  }

  return {
    who,
    context,
    date: dateMatch[1],
    ...(dateMatch[2] && { time: dateMatch[2] }),
    ...(dateMatch[3] && { tz: dateMatch[3] }),
  };
}

export function parseSourceAttribution(text: string): SourceAttribution | null {
  const m = text.match(SOURCE_ATTRIBUTION_RE);
  if (!m) return null;
  return parseAttributionInner(m[1]);
}

export function extractAllSourceAttributions(
  text: string,
): SourceAttribution[] {
  const results: SourceAttribution[] = [];
  const re = new RegExp(SOURCE_ATTRIBUTION_RE_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const parsed = parseAttributionInner(m[1]);
    if (parsed) results.push(parsed);
  }
  return results;
}

export function renderSourceAttribution(s: SourceAttribution): string {
  let dateField = s.date;
  if (s.time) dateField = `${dateField} ${s.time}`;
  if (s.tz) dateField = `${dateField} ${s.tz}`;
  const parts: string[] = [s.who];
  if (s.context) parts.push(s.context);
  parts.push(dateField);
  return `[Source: ${parts.join(', ')}]`;
}

/**
 * Check whether a claim has at least one evidence entry with a parseable
 * source attribution in its `note` or `path` field, or whether the claim's
 * text itself carries the attribution inline.
 *
 * Returns true if the claim is adequately sourced, false otherwise.
 */
export function claimHasSourceAttribution(claim: WikiClaim): boolean {
  // Inline attribution in claim text
  if (SOURCE_ATTRIBUTION_RE.test(claim.text)) return true;

  // Any evidence entry with attribution
  if (Array.isArray(claim.evidence)) {
    for (const e of claim.evidence) {
      if (evidenceHasSourceAttribution(e)) return true;
    }
  }

  return false;
}

export function evidenceHasSourceAttribution(
  evidence: WikiClaimEvidence,
): boolean {
  if (evidence.note && SOURCE_ATTRIBUTION_RE.test(evidence.note)) return true;
  // A sourceId that resolves to a bridge source page counts as attribution —
  // the bridge source page's frontmatter has full provenance. Callers verify
  // sourceId resolution separately.
  return false;
}

/**
 * Validate a full text block (e.g. a timeline entry body) and return
 * the list of source attributions it contains. A block with zero
 * attributions is a lint violation in strict mode.
 */
export function validateAttributedBlock(text: string): {
  attributions: SourceAttribution[];
  hasAtLeastOne: boolean;
} {
  const attributions = extractAllSourceAttributions(text);
  return { attributions, hasAtLeastOne: attributions.length > 0 };
}
