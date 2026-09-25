import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blueprint = readFileSync(path.join(root, 'render.yaml'), 'utf8');

function blueprintValue(key) {
  const match = blueprint.match(new RegExp(`^\\s*- key: ${key}\\r?\\n\\s+value: ([^\\r\\n]+)`, 'm'));
  return match?.[1].trim();
}

test('Render production binds the dedicated Firebase project and legacy production database', () => {
  assert.equal(blueprintValue('NODE_ENV'), 'production');
  assert.equal(blueprintValue('PRINTQ_ENVIRONMENT'), 'production');
  assert.equal(blueprintValue('STUDENT_AUTH_PROVIDER'), 'firebase');
  assert.equal(blueprintValue('FIREBASE_PROJECT_ID'), 'printqs-production');
  assert.equal(blueprintValue('DATABASE_NAMESPACE'), 'printq_db_f68p');
  assert.match(blueprint, /^\s*- key: FIREBASE_AUTH_API_KEY\r?\n(?:\s*#.*\r?\n)*\s*sync: false\s*$/m);
});
