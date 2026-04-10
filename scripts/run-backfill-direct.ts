import { spawnSync } from 'child_process';
import path from 'path';
import { OneCLI } from '@onecli-sh/sdk';

const ONECLI_URL = process.env.ONECLI_URL ?? 'http://127.0.0.1:10254';

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

  const onecli = new OneCLI({ url: ONECLI_URL });
  const ok = await onecli.applyContainerConfig(args, { addHostMapping: false });
  if (!ok) {
    console.error('OneCLI gateway not reachable. Aborting.');
    process.exit(1);
  }
  if (process.platform === 'darwin') {
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }

  // NODE_PATH lets the standalone script require packages from the
  // agent-runner's installed deps (`/app/node_modules`) even though
  // the script lives outside that tree.
  args.push('-e', 'NODE_PATH=/app/node_modules');
  args.push('--entrypoint', '/bin/bash');
  args.push('nanoclaw-agent:latest');
  args.push(
    '-c',
    'node /workspace/project/scripts/backfill-entities-via-sdk.cjs',
  );

  console.log('docker run...');
  const result = spawnSync('docker', args, {
    stdio: 'inherit',
    timeout: 1800_000,
  });
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
