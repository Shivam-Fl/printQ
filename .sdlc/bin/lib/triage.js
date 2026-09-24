// Risk-scoring for intake. Cheap keyword matching, no model.
//
// The bar: false positives cost one `/sdlc approve`, false negatives let an agent plan a
// change to payments or migrations unsupervised. So it errs toward stopping.
//
// But it must not err *stupidly*. A gate that fires on issues it plainly should not trains
// people to approve reflexively, and an approval nobody reads is the same as no gate.

const RISKY = [
  [/\bmigrat(e|ion)|\bschema change|\balter table|\bdrop (table|column)/i, 'database migration'],
  [/\bauth(entication|orisation|orization)?\b|\blogin\b|\bpassword\b|\bsession\b|\bpermission/i, 'authentication or permissions'],
  [/\bpayment|\bbilling|\bstripe|\brazorpay|\bcharge(d|s)?\b|\brefund|\binvoice/i, 'payments'],
  [/\binfra(structure)?\b|\bterraform\b|\bkubernetes\b|\bdeploy pipeline|\bsecret(s)?\b|\bcredential/i, 'infrastructure or secrets'],
];

/**
 * Remove the parts of an issue that describe what will NOT be done.
 *
 * An issue saying "out of scope: payments" is the clearest possible signal that payments are
 * not being touched — and scanning it naively turns that sentence into the reason the issue
 * is blocked. Same for a notes section quoting a config key or a past migration by name.
 */
export function strippedForRisk(body = '') {
  const EXCLUDING_HEADING =
    /^#{1,6}\s*.*(out of scope|not in scope|non-?goals?|explicitly excluded|will not|won'?t do|notes for|background|prior art)\b.*$/i;

  const out = [];
  let skipping = false;
  let skipDepth = 0;

  for (const line of String(body).split('\n')) {
    const heading = line.match(/^(#{1,6})\s/);
    if (heading) {
      const depth = heading[1].length;
      if (EXCLUDING_HEADING.test(line)) { skipping = true; skipDepth = depth; continue; }
      // A heading at the same level or higher ends the excluded section.
      if (skipping && depth <= skipDepth) skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/**
 * @returns {{risky: string[], scanned: string}} areas that need a human, and what was scanned
 */
export function riskAreas(issue = {}) {
  const scanned = strippedForRisk(`${issue.title ?? ''}\n${issue.body ?? ''}`);
  const risky = RISKY.filter(([re]) => re.test(scanned)).map(([, name]) => name);
  return { risky: [...new Set(risky)], scanned };
}

/** Does a bug report carry enough to reproduce it? */
export function hasReproSteps(body = '') {
  const b = String(body);
  return /^\s*1[.)]\s/m.test(b)               // a numbered list
    || /\bsteps?\s+to\s+reproduce\b/i.test(b)
    || /\breproduc(e|tion)\b/i.test(b)
    || /\bwhen i\b|\bgo to\b|\bnavigate to\b/i.test(b);
}

/** Cheap title-overlap duplicate check. No model. */
export function findDuplicate(title, openIssues = [], { threshold = 0.7, minWords = 3 } = {}) {
  const words = new Set(String(title).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (words.size < minWords) return null;        // too short to judge
  for (const other of openIssues) {
    const theirs = new Set(String(other.title).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const shared = [...words].filter((w) => theirs.has(w)).length;
    if (shared / words.size > threshold) return other;
  }
  return null;
}
