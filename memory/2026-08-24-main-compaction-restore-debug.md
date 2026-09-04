# Main restore after Coop compaction (2026-08-24)

## Symptom

After the permanent Coop/Lead conversation was compacted, a browser tab that
retained the old exact Main reference opened with no active conversation. The
old canonical storage ID was `871a194b-8879-40f7-a1fe-656e48e722af`; the live
continuation is local session 58 with storage ID
`34ff2965-cab7-437c-88d9-d5230beae551`.

## Root cause

The connection restore path intentionally treats an exact reference miss as a
hard empty state. Compaction hides the predecessor and records
`compactedIntoLocalId` on it plus `compactedFromStorageId` on the successor, but
the Lead restore path did not use that durable edge. A stale Main tab therefore
received no `session_switched` event and could not clear its stale tab/URL
reference.

## Fix

When the exact request is for the canonical Coop/Lead home, restore follows
only a verified hidden-source → visible-successor compaction edge. Ordinary
project exact SessionRefs still fail closed on a miss and are not redirected.
The successor's normal `session_switched` payload lets the existing client home
handler clear the stale Lead tab reference.

## Verification

- With the new restore logic removed, the regression failed: 0 pass, 1 fail.
- With the logic restored, `node --test test/project-connection-state.test.js`
  passed 12/12.
- The live session files confirm the exact predecessor/successor edge above;
  no live session or ledger record was modified.
