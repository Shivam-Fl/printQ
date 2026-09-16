// Parses privileged `/sdlc ...` commands out of GitHub comments.
//
// SECURITY BOUNDARY. Everything downstream of this file acts on the result: merging,
// overriding gates, resetting budgets. Issue and PR comments are attacker-controlled text on
// any repo that accepts outside contributions, so the rules here are deliberately rigid:
//
//   1. A command is only a command at the START of a line. Text that merely mentions
//      "/sdlc approve" inside a sentence, a quote, or a code block is prose.
//   2. Authority comes from the comment's AUTHOR and their association with the repo —
//      never from the comment's content. No string in a comment body can grant permission.
//   3. Unknown commands are rejected, not ignored. Silence looks like success to a caller.

export const COMMANDS = {
  approve:  { needsAllowlist: true,  description: 'approve the pending work order or merge' },
  reject:   { needsAllowlist: true,  description: 'reject the pending work order' },
  merge:    { needsAllowlist: true,  description: 'merge the PR' },
  retry:    { needsAllowlist: true,  description: 'retry the current stage (consumes an attempt)' },
  override: { needsAllowlist: true,  description: 'bypass a gate — recorded in the ledger' },
  stop:     { needsAllowlist: true,  description: 'halt this issue and hand it to a human' },
  status:   { needsAllowlist: false, description: 'print the ledger (read-only, harmless)' },
};

// GitHub author_association values that indicate write access to this repo.
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** Strip fenced code blocks and quoted replies so their contents can never be parsed. */
function stripNonCommandRegions(body) {
  return body
    .replace(/```[\s\S]*?```/g, '')   // fenced blocks
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/^\s*>.*$/gm, '');       // quoted text — a reply quoting a command is not a command
}

/**
 * @param {{body: string, author: string, association?: string}} comment
 * @param {{allowlist?: string[]}} config
 * @returns {{command: string, args: string[], authorized: boolean, reason?: string} | null}
 *          null when the comment contains no command at all.
 */
export function parseCommand(comment, config = {}) {
  const body = String(comment?.body ?? '');
  const cleaned = stripNonCommandRegions(body);

  // Only at the start of a line, and only the first one — a comment does not get to
  // queue up a sequence of privileged actions.
  const match = cleaned.match(/^[ \t]*\/sdlc[ \t]+(\S+)[ \t]*(.*)$/m);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const args = match[2].trim() ? match[2].trim().split(/\s+/) : [];

  const spec = COMMANDS[command];
  if (!spec) {
    return { command, args, authorized: false, reason: `unknown command "/sdlc ${command}"` };
  }

  if (!spec.needsAllowlist) return { command, args, authorized: true };

  const allowlist = (config.allowlist ?? []).map((u) => u.toLowerCase());
  const author = String(comment?.author ?? '').toLowerCase();
  const association = comment?.association;

  if (!author) {
    return { command, args, authorized: false, reason: 'comment has no author' };
  }
  if (!allowlist.includes(author)) {
    return { command, args, authorized: false, reason: `@${comment.author} is not on the allowlist` };
  }
  // Belt and braces: allowlisted AND demonstrably associated with the repo. An allowlist
  // entry alone would survive a username being renamed and reclaimed by someone else.
  if (association !== undefined && !TRUSTED_ASSOCIATIONS.has(association)) {
    return {
      command, args, authorized: false,
      reason: `@${comment.author} is allowlisted but has association ${association}`,
    };
  }
  return { command, args, authorized: true };
}
