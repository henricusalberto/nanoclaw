/**
 * Manually triggers the dream cycle inside the nanoclaw-agent container,
 * using the same mounts + OneCLI credential injection the nightly cron
 * uses. Bypasses the 03:00 CET schedule so we can see Tier 1/2/3
 * enrichment results immediately.
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
  args.push(
    '-c',
    'cd /workspace/project && node dist/wiki/cli.js dream /workspace/wiki-inbox/wiki',
  );

  console.log('Running dream cycle inside container...');
  const result = spawnSync('docker', args, {
    stdio: 'inherit',
    timeout: 1800_000, // 30 min
  });
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
