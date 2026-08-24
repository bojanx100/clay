# Historical Coop ledger ghost recovery

## Symptom

The live historical inventory repeatedly reported `portfolio-tool-route` as
unreconciled even though its exact Clay SessionRef
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/630f2f8f-520b-477f-9c69-9402dfc170a3`
was absent. Its binding was persisted as `active` without a coordinator
SessionRef. Two restart-interrupted Webapp child rows were also reported as
unreconciled even though their exact parent binding was already terminal
`failed`.

## Root cause

An active project-coordinator binding without `coordinator` cannot represent a
committed execution: the normal commit path requires that exact ref. The
binding loader nevertheless rejected the whole store as malformed, leaving the
historical session row active forever. Separately, historical classification
required a child-local terminal action even when its authoritative parent
binding already carried a terminal status.

## Repair

The loader now recovers only the narrow ref-less active/unavailable
project-coordinator shape with no completion markers, writes a durable
`cancelled` tombstone with `session_missing_without_execution_ref`, and keeps
all other malformed state fail-closed. Historical classification now accepts a
terminal binding status as reconciliation evidence, including restart-
interrupted duplicate child rows.

## Verification

The new binding regression fails against the old loader because it reports
`malformed_state`, and passes with the recovery. The history regression fails
against the old classifier because the failed child remains unresolved, and
passes with the terminal-binding evidence. Focused suites and the full test
suite are required before deployment; this source change does not itself edit
the live daemon's in-memory stores.
