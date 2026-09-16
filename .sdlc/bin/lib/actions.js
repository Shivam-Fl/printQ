// Shared helpers for the workflow scripts: gh calls, step outputs, config loading.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const exec = promisify(execFile);
const ROOT = process.env.SDLC_ROOT ?? process.cwd();

export async function gh(args, opts = {}) {
  const { stdout } = await exec('gh', args, { maxBuffer: 20 * 1024 * 1024, ...opts });
  return stdout.trim();
}

export async function ghJson(args) {
  return JSON.parse(await gh(args));
}

export function setOutput(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  if (process.env.GITHUB_OUTPUT) {
    const delim = 'EOF_' + Math.random().toString(36).slice(2);
    appendFileSync(process.env.GITHUB_OUTPUT, key + '<<' + delim + '\n' + v + '\n' + delim + '\n');
  }
  process.stdout.write(key + '=' + v + '\n');
}

/**
 * js-yaml is imported LAZILY. Some scripts run before `npm ci` — ci-verify reads
 * `verify.install` from config to decide how to install in the first place — so a top-level
 * dependency import here is a bootstrap deadlock: the config that says how to install
 * cannot be read until after installing.
 */
export async function loadConfig(root = ROOT) {
  const path = join(root, '.sdlc', 'config.yml');
  if (!existsSync(path)) die('no .sdlc/config.yml — run `sdlc init` first');
  const { load: parseYaml } = await import('js-yaml');
  return parseYaml(readFileSync(path, 'utf8')) ?? {};
}

export function die(message, code = 1) {
  process.stderr.write('sdlc: ' + message + '\n');
  process.exit(code);
}

export function flags(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export const repo = () => process.env.GITHUB_REPOSITORY ?? die('GITHUB_REPOSITORY is not set');

/** Extract the first fenced json block from a markdown body. */
export function extractJsonBlock(body) {
  const m = String(body ?? '').match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
