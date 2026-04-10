/**
 * Shared wrapper for spawning the in-container `claude` CLI in
 * one-shot (`-p --bare`) mode. Every host-side LLM call from the wiki
 * pipeline — entity-scan, image OCR, future dream-cycle enrichers —
 * goes through here so the argv surface, timeout handling, and error
 * shape live in ONE place.
 *
 * Auth flows through the OneCLI proxy already baked into the container
 * image; callers don't need to inject API keys.
 */

import { spawnCapture } from './spawn-util.js';

export interface ClaudeCliCallOptions {
  /** The user prompt. Sent as a positional argv, same as an interactive call. */
  prompt: string;
  /** Haiku / Sonnet / Opus. Defaults to Haiku 4.5 (cheap cron workloads). */
  model?: string;
  /** Hard wall-clock limit. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * JSON schema to constrain the response shape. The CLI enforces this
   * via `--json-schema <stringified>` and guarantees parsed output
   * matches on success.
   */
  jsonSchema?: object;
  /**
   * Image path to attach (vision). Passed as `--image <path>`. Only
   * supply for image-capable models.
   */
  imagePath?: string;
}

export interface ClaudeCliCallResult {
  /** Raw stdout as returned by the CLI. */
  stdout: string;
  /** Convenience: JSON.parse(stdout) when a schema was supplied. null on failure. */
  json: unknown;
}

/**
 * One-shot call. Throws on non-zero exit, timeout, or spawn failure —
 * callers wrap in try/catch and decide whether to fall back to an
 * empty result or surface the error.
 */
export async function callClaudeCli(
  opts: ClaudeCliCallOptions,
): Promise<ClaudeCliCallResult> {
  const args: string[] = [
    '-p',
    '--bare',
    '--model',
    opts.model ?? 'claude-haiku-4-5',
    '--output-format',
    'text',
    '--dangerously-skip-permissions',
  ];
  if (opts.jsonSchema) {
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }
  if (opts.imagePath) {
    args.push('--image', opts.imagePath);
  }
  // Prompt last — claude's positional arg.
  args.push(opts.prompt);

  const { stdout } = await spawnCapture('claude', args, {
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  let json: unknown = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      // Forgive fenced JSON even though --json-schema should prevent it.
      const cleaned = trimmed
        .replace(/^```(?:json)?\n/, '')
        .replace(/\n```$/, '');
      json = JSON.parse(cleaned);
    } catch {
      // Leave json null — caller inspects stdout directly if they care.
    }
  }
  return { stdout, json };
}
