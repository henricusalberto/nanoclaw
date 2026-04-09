/**
 * Filesystem helpers shared across the wiki module.
 */

import fs from 'fs';
import path from 'path';

/**
 * Write a file atomically: ensures the parent dir exists, writes to a temp
 * sibling, then renames into place. Concurrent readers never see a partial
 * file. Renames are atomic on POSIX within the same filesystem.
 */
export function atomicWriteFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const temp = `${absPath}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, absPath);
}

/**
 * Read a JSON file. Returns the fallback when the file is missing or
 * unparseable. Use for state files where corruption should self-heal.
 */
export function readJsonOrDefault<T>(absPath: string, fallback: T): T {
  if (!fs.existsSync(absPath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}
