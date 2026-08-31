import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'apps', 'web', 'public', 'downloads');
mkdirSync(output, { recursive: true });
for (const file of readdirSync(output)) {
  if (file === 'printq-agent.tgz' || /^printq-agent-.*\.tgz$/.test(file)) {
    rmSync(path.join(output, file), { force: true });
  }
}

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this packager through `npm run package:agent`.');
const packed = spawnSync(process.execPath, [npmCli, 'pack', '--workspace', 'apps/agent', '--pack-destination', output], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (packed.status !== 0) process.exit(packed.status ?? 1);
const generated = packed.stdout.trim().split(/\r?\n/).at(-1);
if (!generated) throw new Error('npm pack did not return an archive name');
renameSync(path.join(output, generated), path.join(output, 'printq-agent.tgz'));
console.log('Packaged downloadable agent: apps/web/public/downloads/printq-agent.tgz');
