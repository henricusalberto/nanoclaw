/**
 * Unified extractor interface.
 *
 * Every extractor — whether it reads a PDF, fetches a YouTube transcript,
 * or calls a vision model on an image — produces the SAME shape:
 * `ExtractedContent`. This keeps the bridge and Janus's ingest logic
 * blissfully source-agnostic. Add a new content type by adding one file
 * to the registry; no other wiki code changes.
 *
 * Extractors throw on failure. The bridge catches and emits a
 * reference-only stub source page so the user still sees *something* in
 * the wiki pointing at the original asset.
 */

/** What the registry hands to an extractor's canHandle/extract methods. */
export interface ExtractorInput {
  /** Discriminator — file on disk, URL, or an external bookmark id. */
  kind: 'file' | 'url' | 'bookmark-id';
  /** Absolute filesystem path when kind === 'file'. */
  path?: string;
  /** Fully-qualified URL when kind === 'url'. */
  url?: string;
  /** Opaque external id (e.g., fieldtheory bookmark) when kind === 'bookmark-id'. */
  bookmarkId?: string;
  /** Optional hint from the caller (e.g., pre-sniffed mime type). */
  mimeType?: string;
}

/**
 * The canonical extraction result. All extractors emit this shape so the
 * bridge writes all source pages with identical frontmatter + body layout.
 *
 * The `metadata` field is a free-form bag for extractor-specific data
 * (yt-dlp view counts, fieldtheory category, pdf page count). It is
 * preserved verbatim in the source page frontmatter but never queried by
 * the bridge itself.
 */
export interface ExtractedContent {
  /** Display title for the source page H1. */
  title: string;
  /** Markdown-ready body content. Fenced by the bridge under `## Content`. */
  body: string;
  /** Best-guess mime type of the original asset. */
  mimeType: string;
  /** Which extractor handled this — `pdf`, `youtube`, `fieldtheory`, etc. */
  extractorName: string;
  /** Extractor version. Bumping this forces re-extraction of affected pages. */
  extractorVersion: string;
  /** ISO-8601 extraction timestamp. */
  extractedAt: string;
  /** Extractor-specific metadata (frontmatter). */
  metadata: Record<string, unknown>;
  /** Original URL when applicable. */
  originalUrl?: string;
  /** Original on-disk path when applicable. */
  originalPath?: string;
}

/**
 * An extractor is a lazily-loaded unit of logic that knows how to read
 * one content type. Stateless and side-effect-free beyond whatever the
 * underlying CLI/API does. Each extractor declares its own version so
 * the bridge's `renderFingerprint` can force re-extraction when the
 * wrapper's output changes.
 */
export interface Extractor {
  /** Machine name — also shown in source page frontmatter. */
  name: string;
  /** Bump when the extractor's output format changes. */
  version: string;
  /** Cheap routing check — no I/O. */
  canHandle(input: ExtractorInput): boolean;
  /** Do the work. May throw; bridge catches and emits a stub page. */
  extract(input: ExtractorInput): Promise<ExtractedContent>;
}

/**
 * Build a reference-only ExtractedContent for graceful degradation.
 * The bridge calls this when the matched extractor throws OR when no
 * extractor matches at all. Janus still sees a source page pointing at
 * the original asset and can investigate manually.
 */
export function buildReferenceOnlyContent(params: {
  input: ExtractorInput;
  reason: string;
  attemptedExtractor?: string;
}): ExtractedContent {
  const pointer =
    params.input.url ??
    params.input.path ??
    params.input.bookmarkId ??
    '(unknown)';
  return {
    title: `Reference: ${pointer}`,
    body: [
      `**Extraction failed.**`,
      '',
      `Reason: ${params.reason}`,
      '',
      `Original: \`${pointer}\``,
      '',
      params.attemptedExtractor
        ? `Attempted extractor: \`${params.attemptedExtractor}\``
        : 'No extractor matched this input.',
    ].join('\n'),
    mimeType: params.input.mimeType ?? 'application/octet-stream',
    extractorName: 'reference-only',
    extractorVersion: '1',
    extractedAt: new Date().toISOString(),
    metadata: {
      failed: true,
      reason: params.reason,
      ...(params.attemptedExtractor && {
        attemptedExtractor: params.attemptedExtractor,
      }),
    },
    ...(params.input.url && { originalUrl: params.input.url }),
    ...(params.input.path && { originalPath: params.input.path }),
  };
}
