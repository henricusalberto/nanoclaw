/**
 * Manually runs the bookmark classifier inside the nanoclaw-agent
 * container. Mirrors scripts/run-dream-cycle.ts — same mounts, same
 * OneCLI credential injection.
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { OneCLI } from '@onecli-sh/sdk';

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const wikiInboxDir = path.join(projectRoot, 'groups', 'telegram_wiki-inbox');
  const globalDir = path.join(projectRoot, 'groups', 'global');

  const args: string[] = ['run', '--rm', '-i'];
  args.push('-v', `${projectRoot}:/workspace/project:ro`);
  args.push('-v', `${wikiInboxDir}:/workspace/wiki-inbox:rw`);
  args.push('-v', `${globalDir}:/workspace/global:ro`);
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid != null && gid != null) {
    args.push('--user', `${uid}:${gid}`);
    args.push('-e', 'HOME=/home/node');
  }

  const onecli = new OneCLI({ url: 'http://127.0.0.1:10254' });
  const ok = await onecli.applyContainerConfig(args, { addHostMapping: false });
  if (!ok) {
    console.error('OneCLI gateway not reachable. Aborting.');
    process.exit(1);
  }
  if (process.platform === 'darwin') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }
  args.push('-e', 'NODE_PATH=/app/node_modules');
  args.push('--entrypoint', '/bin/bash');
  args.push('nanoclaw-agent:latest');
  // Default: classify unclassified bookmarks only (idempotent).
  // Pass --reclassify-sections as an argv flag to run the one-shot
  // backfill over already-classified bookmarks to add hubSection tags
  // after introducing sub-sections.
  const reclassify = process.argv.includes('--reclassify-sections')
    ? ' --reclassify-sections'
    : '';
  args.push(
    '-c',
    `cd /workspace/project && node dist/wiki/cli.js classify-bookmarks /workspace/wiki-inbox/wiki --apply${reclassify}`,
  );

  console.log('Running bookmark classifier inside container...');
  const result = spawnSync('docker', args, {
    stdio: 'inherit',
    timeout: 2400_000, // 40 min
  });
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
