import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'verify-release-source.mjs');

function gate(eventName, baseRef, headRef) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_BASE_REF: baseRef,
      GITHUB_HEAD_REF: headRef,
    },
  });
}

test('only development can propose a production master release', () => {
  assert.equal(gate('pull_request', 'master', 'development').status, 0);
  assert.notEqual(gate('pull_request', 'master', 'codex/feature').status, 0);
  assert.notEqual(gate('pull_request', 'master', 'main').status, 0);
});

test('feature PRs into development and push CI are allowed', () => {
  assert.equal(gate('pull_request', 'development', 'codex/feature').status, 0);
  assert.equal(gate('push', '', '').status, 0);
});

test('the required CI check invokes the release-source guard', () => {
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /node --test scripts\/verify-release-source\.test\.mjs/);
  assert.match(workflow, /node scripts\/verify-release-source\.mjs/);
});
