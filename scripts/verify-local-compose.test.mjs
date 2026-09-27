import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

test('development Compose ports are bound to loopback only', () => {
  for (const port of ['15432:5432', '6380:6379', '9000:9000', '9001:9001']) {
    assert.match(compose, new RegExp(`- ["']127\\.0\\.0\\.1:${port}["']`));
  }
  assert.doesNotMatch(compose, /^\s*-\s*["'](?:\d+|0\.0\.0\.0):\d+:/m);
});
