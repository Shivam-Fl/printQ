// Cross-field invariants for a QA report.
//
// JSON Schema proves the SHAPE is right. It cannot prove the report is INTERNALLY
// HONEST — that the verdict matches the results, that every bug referenced exists,
// that a "pass" is not hiding a failed acceptance criterion. An agent under pressure
// to look successful will produce exactly that kind of report, so the orchestrator
// checks it rather than trusting it.

const BLOCKING_AC = new Set(['fail', 'blocked', 'not_covered']);

export function checkQaConsistency(r) {
  const errors = [];
  const bad = (m) => errors.push(m);

  const testIds = new Set();
  for (const t of r.tests ?? []) {
    if (testIds.has(t.id)) bad(`duplicate test id ${t.id}`);
    testIds.add(t.id);
  }

  const bugIds = new Set();
  for (const b of r.bugs ?? []) {
    if (bugIds.has(b.id)) bad(`duplicate bug id ${b.id}`);
    bugIds.add(b.id);
  }

  // Dangling references in either direction.
  for (const t of r.tests ?? []) {
    if (t.bug_id && !bugIds.has(t.bug_id)) bad(`${t.id} references ${t.bug_id}, which is not in bugs[]`);
    if (t.status === 'blocked' && !t.blocked_reason) bad(`${t.id} is blocked but gives no blocked_reason`);
    if (t.status === 'fail' && !t.actual) bad(`${t.id} failed but does not say what actually happened`);
  }
  for (const ac of r.acceptance_rollup ?? []) {
    for (const id of ac.test_ids ?? []) {
      if (!testIds.has(id)) bad(`${ac.id} references ${id}, which is not in tests[]`);
    }
    if (ac.status === 'pass' && !(ac.test_ids ?? []).length) {
      bad(`${ac.id} is marked pass but cites no test that proves it`);
    }
  }

  // A failing test that files no bug is an unexplained failure.
  const unexplained = (r.tests ?? []).filter((t) => t.status === 'fail' && !t.bug_id);
  if (unexplained.length) {
    bad(`failing tests with no bug filed: ${unexplained.map((t) => t.id).join(', ')}`);
  }

  // The verdict must follow from the acceptance rollup, not from optimism.
  const acBlocking = (r.acceptance_rollup ?? []).filter((a) => BLOCKING_AC.has(a.status));
  if (r.verdict === 'pass' && acBlocking.length) {
    bad(`verdict is "pass" but ${acBlocking.map((a) => `${a.id}=${a.status}`).join(', ')}`);
  }
  const blockingBugs = (r.bugs ?? []).filter(
    (b) => b.introduced_by_pr !== false && (b.severity === 'critical' || b.severity === 'major'),
  );
  if (r.verdict === 'pass' && blockingBugs.length) {
    bad(`verdict is "pass" but this PR introduced ${blockingBugs.length} critical/major bug(s)`);
  }

  // next_action must agree with the verdict — it is what the orchestrator acts on.
  const allowed = { pass: ['merge'], fail: ['revise', 'escalate'], blocked: ['escalate', 'revise'] };
  if (r.verdict && r.next_action && !allowed[r.verdict].includes(r.next_action)) {
    bad(`verdict "${r.verdict}" is inconsistent with next_action "${r.next_action}"`);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}
