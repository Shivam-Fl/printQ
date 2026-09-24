#!/usr/bin/env node
// Agent 1 — Intake. No model: classify, risk-score, decide whether the pipeline may start.
import { gh, ghJson, setOutput, loadConfig, die } from './lib/actions.js';
import { riskAreas, hasReproSteps, findDuplicate } from './lib/triage.js';

const issue = process.env.ISSUE;
const author = (process.env.AUTHOR ?? '').toLowerCase();
const association = process.env.ASSOCIATION ?? '';
const cfg = await loadConfig();

const data = await ghJson(['issue', 'view', issue, '--json', 'title,body,labels']);
const text = ((data.title ?? '') + '\n' + (data.body ?? '')).toLowerCase();
const labels = (data.labels ?? []).map((l) => l.name);

const say = (body) => gh(['issue', 'comment', issue, '--body', body]);
const label = (name) => gh(['issue', 'edit', issue, '--add-label', name]);

async function stop(state, reason) {
  await say(reason);
  await label('sdlc:needs-human');
  setOutput('next_state', state);
  process.exit(0);
}

// Untrusted reporter: everything downstream acts on this text, so a human triages it first.
const allowlist = (cfg.allowlist ?? []).map((u) => u.toLowerCase());
const trusted = allowlist.includes(author) || ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
if (!trusted) {
  await stop('needs-human',
    'Intake stopped: @' + (process.env.AUTHOR ?? '?') + ' is not an allowlisted reporter.\n\n' +
    'Every agent downstream acts on this issue text, so an outside report is triaged by a human first. ' +
    'A maintainer can start the pipeline with `/sdlc approve`.');
}

// Risk: anything near the blast radius stops before a single token is spent.
// Sections describing what will NOT be done are excluded first — an issue saying
// "out of scope: payments" is the clearest statement that payments are not involved, and
// blocking it for saying so trains people to approve without reading.
const { risky: risks } = riskAreas({ title: data.title, body: data.body });
if (risks.length) {
  await stop('needs-human',
    'Intake stopped: this touches ' + risks.join(' and ') + '.\n\n' +
    'These areas are outside the agents\u2019 blast radius by policy (`forbidden_paths` in ' +
    '`.sdlc/config.yml`). A human should plan this one. Comment `/sdlc approve` to override.');
}

// A bug with no reproduction produces a confident fix for the wrong thing.
const isBug = labels.includes('bug');
const hasRepro = hasReproSteps(data.body);
if (isBug && !hasRepro) {
  await stop('needs-human',
    'Intake stopped: this is labelled a bug but has no reproduction steps.\n\n' +
    'Planning from a vague report produces a confident fix for the wrong thing. ' +
    'Add numbered steps from a clean session, then comment `/sdlc approve`.');
}

// Duplicate check against open issues — cheap title overlap, no model.
const open = await ghJson(['issue', 'list', '--state', 'open', '--limit', '60', '--json', 'number,title']);
const dupe = findDuplicate(data.title, open.filter((o) => String(o.number) !== String(issue)));
if (dupe) {
  await say('Looks like a duplicate of #' + dupe.number + '. Closing — reopen if that is wrong.');
  await gh(['issue', 'close', issue, '--reason', 'not planned']);
  setOutput('next_state', 'blocked');
  process.exit(0);
}

await label('sdlc:planning');
setOutput('next_state', 'planning');
process.stdout.write('intake: proceeding to planning\n');
