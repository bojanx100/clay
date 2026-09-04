# Append-only Session Persistence Latency Fix

## Status

Implemented locally on 2026-08-27. This record corrects the earlier
point-in-time conclusion that heavy session saves did not need work.

## Evidence and cause

`~/.clay/diag-dev.log` contained `[SAVE-SLOW]` records for a 19,901,875-byte,
40,626-event session at 10,075 ms and 6,053 ms. The synchronous writer rewrote
the complete JSONL transcript on every `saveSessionFile` call even though
ordinary events had already been durably appended one line at a time.

## Repair

- Reuse an already-appended transcript when history length matches the append
  high-water mark, no caller marked an in-place history mutation, and metadata
  differs only by `lastActivity`.
- Recover the newest durable history timestamp on restart when it is newer than
  the stale line-one activity timestamp.
- Mark queue and Coop-ingress in-place history edits so they retain the atomic
  complete rewrite.
- Cache unchanged owner-request read projections by file size and mtime while
  forcing every mutation to reload under its lock.
- Make contested Coop ledger locks fail through existing persistence-failure
  paths instead of blocking the daemon event loop with `Atomics.wait`.

## Verification

- `node --test test/session-persistence.test.js test/sessions-persistence-contract.test.js test/project-user-message-queue.test.js test/coop-owner-request-ingress.test.js test/coop-foreground-turn-interrupt.test.js` passed.
- `node --test test/coop-owner-requests.test.js test/coop-topic-index-store.test.js test/sessions-persistence-contract.test.js test/session-persistence.test.js` passed.
- `npm test` passed through the project runner (321 test files).
- Negative controls, each restored afterward:
  - removing the append-only reuse path: 0 pass, 1 fail (second temp rewrite);
  - bypassing the owner-request cache: 0 pass, 1 fail (two fresh reads);
  - reintroducing a 600 ms lock wait: 0 pass, 1 fail (contention exceeded the
    500 ms bound).

## Limitation

No daemon was restarted or deployed from this worktree, so a post-fix production
canary is still required. The test evidence proves the changed paths; it does
not prove that already-running production code is quiet.
