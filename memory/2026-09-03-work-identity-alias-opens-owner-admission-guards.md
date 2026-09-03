# 2026-09-03 — Widened work-identity aliasing opens six owner-admission guards

**Status: OPEN at the time of writing.** Found while investigating an unrelated
task (Lead occupancy decay); not fixed here because the change looks
deliberate and the correct scoping is a call for its author.

## Symptom

`test/coop-thread-execution-admission.test.js` — 42 pass / **6 fail**. Every
failure is a guard that should REFUSE admitting instead:

- owner authorization without a decision still blocks anything not provably read-only
- a matching conversational ingress without explicit owner authorization admits nothing
- a withdrawn owner turn authorizes no review worker
- review admission preserves exact owner project scoping
- a stale review-shaped turn no longer shadows the standing grant
- a review turn that never covered this task cannot claim the route

The first fails with a binding actually created (`bindingRevision: 2`,
`controlRole: council`) under the message "an owner turn that was never recorded
authorizes nothing". These guards fail OPEN: work is admitted without a
recorded, covering owner authorization.

## Bisect

    8687526a9f   48 pass / 0 fail
    f738909689   42 pass / 6 fail   <- "fix: reconcile terminal Coop executions"

Same 48 tests; none were added. The suite has stayed red across every commit
since, so this is not in-flight work that is about to go green.

## Root cause

`lib/work-identity.js:49`, changed by `f738909689`:

    - return match ? repoIssueIdentity(match[1], match[2]) : trimmed;
    + return match ? repoIssueIdentity(match[1], match[2]) : canonicalIssueAlias(trimmed) || trimmed;

`canonicalIssueAlias` collapses `portfolio-webapp-2777` onto
`github:trialview/v2#2777` via `REPOSITORY_ALIASES = { "trialview-v2":
"trialview/v2", "webapp": "trialview/v2" }`.

`normalizeWorkIdentity` is the shared key for matching an owner approval to the
work it covers. Widening it means task ids that were previously DISTINCT now
share one identity, so an approval granted for one task matches a different
task that aliases to the same issue. That is precisely the "never covered this
task" and "withdrawn turn" cases above.

This is live, not hypothetical: `portfolio-webapp-2777` and
`portfolio-webapp-2778` were both active bindings in the store on 2026-09-03 —
exactly the id shape this alias collapses.

## Why it was not fixed here

The alias table carries the comment "Keep this table deliberately closed", so
the widening was intentional and a plain revert would break whatever
`f738909689` needed it for (reconciling terminal Coop executions across id
spellings). The likely correct shape is to scope the aliasing to the
reconciliation call site rather than to the global `normalizeWorkIdentity`, so
approval matching keeps the narrow identity. That is a design decision for the
author of that commit, and silently rewriting authorization matching is a bad
place to guess.

## Reproduce

    node --test test/coop-thread-execution-admission.test.js

Run it from a checkout WITH `node_modules` — a fresh `git worktree` has none and
will report unrelated load failures instead.
