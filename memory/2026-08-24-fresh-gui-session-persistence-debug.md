# Fresh GUI session message persistence failure (2026-08-24)

## Symptom

The first message in a newly opened Clay chat shows:

`The message could not be saved. It was not sent to the provider.`

The provider is not reached because the local message-persistence guard fails first.

## Root cause

GUI-created sessions were initialized with both `cliSessionId` and `storageId` set to
`null`. `recordUserMessage()` appends the first user message before the provider
returns a `cliSessionId`. `appendToSessionFile()` requires a durable storage ID and
returns `false` when it is missing, which emits the user-visible `message_failed`
event with reason `persistence_failed`.

The live project session inventory reproduced the same state: a fresh `New Session`
had `cliSessionId:null`, and daemon logs had no filesystem append failure for the
reported time, consistent with the early missing-ID return.

## Fix

`buildNewSession()` now allocates a UUID storage ID at session creation when the
caller has not supplied `storageId` or `cliSessionId`. Existing explicit IDs remain
unchanged, and the provider can still assign `cliSessionId` later.

## Verification

- Reverted the UUID allocation temporarily: the new regression test failed, 0/1
  passed, with `storageId:null`.
- Restored the fix: focused lifecycle/message/persistence tests passed, 16/16.
- The full suite ran 3,276 tests: 3,271 passed and 5 unrelated pre-existing or
  timing-sensitive failures remained in Coop main-lens interaction, session-save
  coalescing, and the raw-control-byte guard.

## Live activation

The running daemon had not reloaded the patch at the time of diagnosis. Its safe
restart was refused because an active controlled execution lacked an exact
checkpointable target session. The fix takes effect after the next safe daemon
reload; the active controlled execution must not be force-closed for this change.
