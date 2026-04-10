/**
 * Shared wrapper for one-shot Claude calls from the wiki pipeline
 * (entity-scan, image OCR, dream-cycle Tier 1, etc.).
 *
 * Goes through the @anthropic-ai/claude-agent-sdk's `query()` API
 * rather than spawning the standalone `claude` CLI. The standalone
 * CLI's startup auth check rejects the OneCLI placeholder token,
 * which would silently break every wiki cron when invoked from
 * inside a NanoClaw container. The SDK uses the same OneCLI proxy
 * env vars (HTTPS_PROXY + CA cert) that the agent runtime relies on
 * and authenticates correctly.
 *
 * Image attachments are not currently supported via this path —
 * the image extractor needs a separate code path or it can fall
 * back to a reference-only stub when no caller is wired.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeCliCallOptions {
  /** The user prompt. */
  prompt: string;
  /** Haiku / Sonnet / Opus. Defaults to Haiku 4.5 for cheap cron workloads. */
  model?: string;
  /** Hard wall-clock limit. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * Optional JSON schema descriptor — kept on the interface for API
   * compat with callers that used the legacy CLI's --json-schema. The
   * SDK doesn't enforce this server-side, so we treat it as a hint
   * and rely on the prompt to constrain the response shape.
   */
  jsonSchema?: object;
  /**
   * Image path to attach. Not supported via the SDK query() API in
   * this version — callers should fall back to text-only or write a
   * direct REST call.
   */
  imagePath?: string;
}

export interface ClaudeCliCallResult {
  /** Raw text returned by the model. */
  stdout: string;
  /** Convenience: JSON.parse(stdout) when parseable, null otherwise. */
  json: unknown;
}

/**
 * One-shot call. Throws on timeout or SDK error — callers wrap in
 * try/catch and decide whether to fall back to an empty result or
 * surface the error to the user.
 */
export async function callClaudeCli(
  opts: ClaudeCliCallOptions,
): Promise<ClaudeCliCallResult> {
  if (opts.imagePath) {
    // Vision via SDK query() isn't wired here; image extractor handles
    // this case by collapsing to a reference-only stub.
    throw new Error('claude-cli: image attachments not supported via SDK path');
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const model = opts.model ?? 'claude-haiku-4-5';

  const stream = query({
    prompt: opts.prompt,
    options: {
      permissionMode: 'bypassPermissions',
      model,
      // Empty allowedTools — pure text completion, no agentic tool use.
      allowedTools: [],
    },
  });

  // Race the stream against a hard wall-clock timeout so a hung gateway
  // can't lock up entity-scan or the dream cycle.
  const result = await withTimeout(consumeStream(stream), timeoutMs);

  let json: unknown = null;
  const trimmed = result.trim();
  if (trimmed) {
    try {
      // Forgive fenced JSON even when the prompt asked for raw.
      const cleaned = trimmed
        .replace(/^```(?:json)?\n/, '')
        .replace(/\n```$/, '');
      json = JSON.parse(cleaned);
    } catch {
      // Leave json null — caller inspects stdout directly if it cares.
    }
  }
  return { stdout: result, json };
}

async function consumeStream(stream: AsyncIterable<unknown>): Promise<string> {
  let result = '';
  for await (const msg of stream) {
    const m = msg as { type?: string; result?: unknown };
    if (m.type === 'result' && typeof m.result === 'string') {
      result = m.result;
    }
  }
  return result;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`claude SDK call timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
