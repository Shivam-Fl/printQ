// Decides which agent handles a ticket, and who has to look at the result.
//
// Pure functions so the decisions are testable without GitHub. Every one of these is a
// policy choice a project will want to change, which is why they read from config rather
// than being spelled out in a workflow condition.

/**
 * A bug is a question about what a running system is actually doing, and it is answered by
 * reproducing it. A feature is a design problem. Sending both to the same agent is why a
 * planner reasons statically about a bug and produces a confident fix for the wrong thing.
 *
 * @returns {'debugger'|'planner'}
 */
export function agentForIssue(issue = {}, config = {}) {
  const labelNames = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name).toLowerCase());

  // An epic is too large for one work order by definition — that is what the label means.
  // Sending it to the planner produces either a plan that covers a fraction of it, or one
  // so broad no implementer can apply it. It goes to the maintainer to be split first.
  if (labelNames.includes('sdlc:epic') || labelNames.includes('epic')) return 'maintainer';

  if (config.route_bugs_to_debugger === false) return 'planner';
  const labels = labelNames;
  if (labels.includes('bug') || labels.includes('defect') || labels.includes('regression')) {
    return 'debugger';
  }
  // Fall back to the issue form's own classification when a label is missing.
  if (issue.kind === 'bug') return 'debugger';
  return 'planner';
}

/** Which prompt packs run for a stage, in order. */
export function councilFor(stage, config = {}) {
  const mode = config.councils?.[stage] ?? 'single';
  if (mode !== 'council') return [{ role: stage, pack: `${stage}.md` }];

  if (stage === 'plan') {
    return [
      { role: 'proposer', pack: 'plan-council/1-proposer.md', emits: 'plan/proposal.json' },
      { role: 'critic', pack: 'plan-council/2-critic.md', emits: 'plan/critique.json' },
      { role: 'arbiter', pack: 'plan-council/3-arbiter.md', emits: 'work-order.json' },
    ];
  }
  if (stage === 'review') {
    return [
      { role: 'correctness', pack: 'review-council/1-correctness.md', emits: 'review/correctness.json' },
      { role: 'design', pack: 'review-council/2-design.md', emits: 'review/design.json' },
    ];
  }
  return [{ role: stage, pack: `${stage}.md` }];
}

/**
 * Who, if anyone, must look at this plan before code is written.
 *
 * The asymmetry that shapes this: approving a bad plan costs an implement, a CI run and a QA
 * cycle, and usually produces a PR that looks finished. Rejecting a good one costs a replan.
 * So every uncertain case routes upward.
 *
 * @returns {{gate: 'human'|'agent'|'none', reason: string}}
 */
export function planGate(workOrder = {}, config = {}) {
  const gates = config.gates ?? {};
  const min = gates.min_confidence ?? 0;
  const confidence = workOrder.confidence;

  // A bug fix planned without reproducing the bug is a guess, however confident it sounds.
  if (workOrder.kind === 'bug' && workOrder.reproduced === false) {
    return { gate: 'human', reason: 'the bug was never reproduced — the diagnosis is inferred, not observed' };
  }
  // An absent score is not a passing score.
  if (min > 0 && (typeof confidence !== 'number' || confidence < min)) {
    return {
      gate: 'human',
      reason: typeof confidence === 'number'
        ? `confidence ${confidence} is below min_confidence ${min}`
        : `the plan carries no confidence score, and min_confidence is ${min}`,
    };
  }
  if (gates.plan_approval) return { gate: 'human', reason: 'gates.plan_approval is on' };
  if (gates.plan_review_agent) return { gate: 'agent', reason: 'gates.plan_review_agent is on' };
  return { gate: 'none', reason: 'both plan gates are off — code will be written against an unreviewed plan' };
}

/**
 * Findings only reach the PR if they survived the second reviewer's independent check.
 * A single reviewer's false positive lands as fact, wastes the implementer's next attempt,
 * and teaches everyone to skim reviews.
 */
export function mergeReviewFindings(correctness = {}, design = {}) {
  const verdicts = new Map();
  for (const v of design.verification_of_a ?? []) verdicts.set(v.index, v);

  const kept = [];
  const dropped = [];
  (correctness.findings ?? []).forEach((f, i) => {
    const v = verdicts.get(i);
    if (!v || v.status === 'confirmed') {
      kept.push({ ...f, from: 'correctness', verified: Boolean(v) });
    } else if (v.status === 'overstated') {
      kept.push({ ...f, from: 'correctness', verified: true, severity: 'minor', note: v.reasoning });
    } else {
      dropped.push({ ...f, from: 'correctness', dropped_because: v.reasoning });
    }
  });

  for (const f of design.findings ?? []) kept.push({ ...f, from: 'design', verified: true });

  const blocking = kept.filter((f) => f.severity === 'blocking');
  return {
    findings: kept.sort((a, b) => rank(a.severity) - rank(b.severity)),
    dropped,
    verdict: blocking.length ? 'request-changes' : 'approve',
    blocking_count: blocking.length,
  };
}

const rank = (s) => ({ blocking: 0, major: 1, minor: 2 }[s] ?? 3);

/**
 * What did review decide, and therefore where does the PR go next?
 *
 * Until this existed the answer was "nowhere". The reviewer requested changes on the first
 * real PR, said so clearly, and nothing read it — `post-review.mjs` set an output no step
 * consumed. A review nobody routes on is a comment.
 *
 * Two shapes to read, because there are two review modes:
 *   council — `declared` carries the merged verdict, computed from cross-verified findings.
 *   single  — the agent posted a formal review, so GitHub holds the verdict, not us.
 *
 * Returns null when there is nothing to read at all. That is NOT an approval: an agent that
 * finished without reviewing is the absent-value bug this pipeline keeps producing, and the
 * caller escalates it to a human instead of letting silence merge code.
 */
export function reviewVerdict({ declared = null, reviews = [] } = {}) {
  if (declared === 'approve' || declared === 'request-changes') return declared;

  // Latest wins deliberately: a human approving after the bot requested changes is exactly
  // how someone overrides a finding they disagree with, and it must not be outvoted by an
  // older review that is still sitting in the list.
  const states = reviews.map((r) => r?.state).filter(Boolean);
  if (!states.length) return null;

  // COMMENTED is the interesting case. The Actions token cannot submit a formal approval, so
  // a reviewer with nothing blocking to say can only leave a comment — treating that as
  // "no verdict" would strand every clean PR. CHANGES_REQUESTED is the only stop signal.
  return states[states.length - 1] === 'CHANGES_REQUESTED' ? 'request-changes' : 'approve';
}
