#!/usr/bin/env node
// Did the evidence QA cites actually survive?
//
// QA drove a real browser, took screenshots and recorded a trace for the bug it found — into
// /tmp/qa-evidence/, outside the workspace. The upload step globs the workspace, so it matched
// the report and nothing else, and `if-no-files-found: warn` said so in a line nobody reads.
// The report shipped citing three files that no longer exist anywhere.
//
// The prompt had said "trace/video/HAR on" without saying WHERE, which is the same mistake as
// asking a model to open a PR: an instruction satisfiable in more than one way eventually gets
// satisfied the other way. The workflow now names the directory — and this checks it was used,
// because "the agent wrote it somewhere else" is otherwise indistinguishable from "the agent
// took no screenshots at all".

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { setOutput, die } from './lib/actions.js';

const report = JSON.parse(readFileSync(process.env.REPORT ?? 'qa-report.json', 'utf8'));
const dir = resolve(process.env.QA_EVIDENCE_DIR ?? 'qa-evidence');

const cited = [
  ...(report.bugs ?? []).flatMap((b) => b.evidence ?? []),
  ...(report.tests ?? []).flatMap((t) => t.evidence ?? []),
  ...Object.values(report.artifacts ?? {}),
].filter((e) => typeof e === 'string' && /[/\\]/.test(e) && !/^https?:/.test(e));

const count = (d) => (existsSync(d) && statSync(d).isDirectory()
  ? readdirSync(d, { recursive: true }).filter((f) => statSync(resolve(d, f)).isFile()).length
  : 0);
const kept = count(dir);
setOutput('files', String(kept));

// Cited paths that are outside the collected directory, or simply absent, are dead links.
const lost = cited.filter((p) => {
  const abs = resolve(p);
  return relative(dir, abs).startsWith('..') || !existsSync(abs);
});

if (!lost.length) {
  process.stdout.write(`evidence: ${kept} file(s) collected, ${cited.length} cited, all present\n`);
  process.exit(0);
}

// Loud, and fatal. A bug report whose evidence cannot be opened is a claim, and the whole
// point of driving a real browser is that QA's claims are checkable.
die(`the report cites ${lost.length} evidence file(s) that will not survive this run:\n` +
    lost.map((p) => `  ${p}`).join('\n') +
    `\n\nEverything QA keeps must be written under ${dir} (QA_EVIDENCE_DIR) — ` +
    `${kept} file(s) are there now. Anything elsewhere on the runner is discarded when it is destroyed.`);
