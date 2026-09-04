# Urban Stay Policy Recovery Debug Report

## Symptom

Startup finite recovered-Thread admission stopped at the historical Voice target's
`recovery_target_conflict`. The valid ingress 406 recovery was never attempted, and
canonical owner ingress 409 remained conversational with no Thread, ProjectRef, or
implementation decision.

## Root cause

`coop-recovered-thread-admission.migrateProductionFromSessionManager()` was a
fail-fast sequence. It returned immediately after any earlier migration failure even
though each finite migration verifies and mutates a separate exact target.

Ingress 409 also had no finite recovery boundary. Its generic implementation parser
correctly returned no decision because the owner wording was not a supported generic
Thread command, so only a digest-bound repair could safely admit it.

The supplied zero-based persisted JSONL position was 178409. Clay removes the metadata
line when loading a session, so the canonical session-history and owner-request event
reference is 178408. The live ledger and loader behavior both confirm that distinction.

## Fix

- Run every finite recovered-Thread migration independently, collect every result, and
  return all failures without allowing one conflict or exception to block later repairs.
- Add a separate ingress 409 recovery pinned to canonical session
  `871a194b-8879-40f7-a1fe-656e48e722af`, sequence 409, loaded event index 178408,
  persisted JSONL position 178409, timestamp 1786899212690, exact text and route state,
  and SHA-256 digest
  `0ea3b5735a54ad11fae95fe5f7e34f0eb8a4ee785ab24a038645aef9728e58c7`.
- Create or verify exactly one open Thread,
  `recovery-urban-stay-policy-409`, bound only to Urban Stay ProjectRef
  `51e67388-cea0-52b7-8e01-cde68cae713c`, then add the exact immutable source event
  membership and persist one explicit implementation decision.
- Reject changed or duplicated events, session or ledger drift, conflicting Thread
  identity, unrelated execution evidence, and mismatched typed implementation scope.
- Preserve the existing ingress 406 recovery unchanged. The recovered decision grants
  implementation admission for the exact Urban Stay policy Thread; external actions
  remain governed by the existing approval gate.

## Evidence

- Before the fix, a deterministic stub reproduction recorded only the Voice migration
  call and returned its conflict.
- Focused recovery suite: 28/28 passed.
- Recovery plus owner-request and typed execution integration suite: 100/100 passed.
- Repository-wide isolated suite: 2741/2741 passed.
- A dry-run against temporary copies of the live topic index and owner-request ledger,
  using the canonical live session history, reported Voice's conflict while successfully
  applying both ingresses 406 and 409. The second run reported `threadCreated: false`,
  `membershipAdded: false`, and `decisionBackfilled: false` for both, proving startup
  idempotence. Live files were never mutated.

## Regression tests

- `test/coop-recovered-thread-admission.test.js`
- `test/coop-urban-stay-policy-recovery.test.js`
- Existing ingress 360, 371, and 406 recovery tests remain green.

## Related

Finite recoveries are independent exact migrations sharing only their startup
coordinator. Future additions must keep per-target failure isolation, immutable source
events, digest/session/event guards, and typed ProjectRef admission.

## Status

DONE
