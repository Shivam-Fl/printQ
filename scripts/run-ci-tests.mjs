/**
 * Emit one machine-readable JUnit report per workspace. Keeping these reports
 * separate makes an API, shared-contract, or web failure attributable in CI
 * without relying on a developer's local Docker daemon.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.join(root, '.tmp', 'ci-results');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const workspaces = [
  ['shared', path.join(root, 'packages', 'shared')],
  ['api', path.join(root, 'apps', 'api')],
  ['web', path.join(root, 'apps', 'web')],
];

await rm(reportDir, { recursive: true, force: true });
await mkdir(reportDir, { recursive: true });

for (const [name, cwd] of workspaces) {
  const report = path.join(reportDir, `${name}.junit.xml`);
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [vitest, 'run', '--reporter=junit', `--outputFile=${report}`],
      { cwd, env: process.env, stdio: 'inherit', windowsHide: true },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  if (exitCode !== 0) process.exit(exitCode);
}
