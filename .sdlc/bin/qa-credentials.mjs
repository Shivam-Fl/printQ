#!/usr/bin/env node
// Produces the credentials QA uses, without ever storing a password anywhere.
//
// The obvious designs are both wrong:
//   - QA signs up and saves the credentials for reuse -> saved WHERE? memory/ and the ledger
//     are both git. That puts a working password in the repository, permanently.
//   - QA signs up fresh every run and discards -> no reuse, and the database fills with
//     orphaned accounts nobody cleans up.
//
// So: DERIVE them. One seed secret lives in GitHub Secrets; every account's password is an
// HMAC of that seed and a stable identity. Nothing is stored, the same identity always yields
// the same password (so accounts are reusable across runs), and the seed can be rotated in
// one place. A leaked derived password compromises one throwaway test account, not the seed.

import { createHmac } from 'node:crypto';
import { loadConfig, setOutput, die } from './lib/actions.js';

const cfg = await loadConfig();
const auth = cfg.qa_auth ?? {};
const mode = auth.mode ?? 'none';

if (mode === 'none') {
  setOutput('mode', 'none');
  process.stdout.write('qa_auth.mode is "none" — QA will test unauthenticated flows only\n');
  process.exit(0);
}

if (mode === 'secrets') {
  // Accounts that cannot be self-created: SSO, admin roles, anything provisioned by hand.
  // The values arrive as env from GitHub Secrets; this step only reports which are present
  // so a missing one fails here rather than as a confusing login timeout mid-run.
  const names = auth.secrets ?? ['QA_USER_EMAIL', 'QA_USER_PASSWORD'];
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    die(`qa_auth.mode is "secrets" but these are not set: ${missing.join(', ')}\n` +
        `  gh secret set ${missing[0]} --repo <owner>/<repo>`);
  }
  setOutput('mode', 'secrets');
  process.stdout.write(`credentials supplied via secrets: ${names.join(', ')}\n`);
  process.exit(0);
}

if (mode !== 'derived') die(`unknown qa_auth.mode "${mode}" — expected none, secrets or derived`);

const seed = process.env.QA_FIXTURE_SEED;
if (!seed) {
  die('qa_auth.mode is "derived" but QA_FIXTURE_SEED is not set.\n' +
      '  Generate one and store it once:\n' +
      '    gh secret set QA_FIXTURE_SEED --repo <owner>/<repo>   # paste any long random string\n' +
      '  Every QA password is derived from it, so nothing else needs storing.');
}

// Scope decides reuse. "run" gives a fresh account per QA run — no state carried between
// runs, at the cost of a new row each time. "pr" reuses one account across a PR's retries,
// which is usually what you want: the fix loop re-runs QA and a stable login is one less
// variable. "global" reuses one account forever, for an app where signup is expensive.
const scope = auth.scope ?? 'pr';
const pr = process.env.PR ?? '0';
const run = process.env.GITHUB_RUN_ID ?? '0';
const key = { run: `run-${run}`, pr: `pr-${pr}`, global: 'global' }[scope] ?? `pr-${pr}`;

const roles = auth.roles ?? ['primary'];
const domain = auth.email_domain ?? 'qa.invalid';   // RFC 2606: guaranteed never deliverable

const accounts = roles.map((role) => {
  const identity = `${key}:${role}`;
  // Separate HMAC contexts so the password can never equal any other derived value.
  const password = createHmac('sha256', seed).update(`password:${identity}`).digest('base64url').slice(0, 24) + 'aA1!';
  return {
    role,
    email: `qa-${identity.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}@${domain}`,
    password,
  };
});

// Masked in the log so a password never appears in a workflow run anyone can read.
for (const a of accounts) process.stdout.write(`::add-mask::${a.password}\n`);

setOutput('mode', 'derived');
setOutput('scope', scope);
setOutput('accounts', JSON.stringify(accounts));
setOutput('signup_url', auth.signup_url ?? '');

process.stdout.write(
  `derived ${accounts.length} account(s), scope=${scope}:\n` +
  accounts.map((a) => `  ${a.role}: ${a.email}`).join('\n') + '\n' +
  'Passwords are derived from QA_FIXTURE_SEED and are not stored anywhere.\n',
);
