/**
 * Shared child-process helper used by CLI-wrapping extractors. Keeps the
 * timeout / stdout-capture / error-shape boilerplate in one place so
 * individual extractors stay thin.
 */

import { spawn } from 'child_process';

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface SpawnOptions {
  /** Hard timeout in ms. Default 60s — CLI extractors should not wait forever. */
  timeoutMs?: number;
  /** Additional env vars merged into the child. */
  env?: NodeJS.ProcessEnv;
  /** stdin payload to write. */
  stdin?: string;
  /** Working directory. */
  cwd?: string;
  /** Max stdout bytes before we kill the process. Default 16 MiB. */
  maxStdoutBytes?: number;
}

/**
 * Spawn a command, capture stdout/stderr, and resolve on exit. Rejects
 * on non-zero exit code, timeout, or stdout overflow — callers catch and
 * turn the error into a reference-only source page.
 */
export async function spawnCapture(
  command: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const maxStdoutBytes = opts.maxStdoutBytes ?? 16 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        env: { ...process.env, ...opts.env },
        cwd: opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new Error(`failed to spawn ${command}: ${(err as Error).message}`),
      );
      return;
    }

    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killedForOverflow = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        if (!killedForOverflow) {
          killedForOverflow = true;
          child.kill('SIGKILL');
          clearTimeout(timer);
          reject(
            new Error(
              `${command} exceeded max stdout size (${maxStdoutBytes})`,
            ),
          );
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killedForOverflow) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
