# Duplicate worker terminal updates

## Symptom

One coordinated worker produced two coordinator updates for the same task: an
empty `completed` update followed by a `needs_input` update after it was
stopped.

## Root cause

The orchestration watcher remained subscribed after processing a terminal
`done` event and did not guard on the task's current status. Any later `done`
event for that worker could run terminal reconciliation again, overwrite the
task status, and enqueue another synthetic coordinator message.

## Fix

The watcher now accepts terminal events only while the task is `running`,
unsubscribes before finishing the task, and stores the unsubscribe handle on
the worker. Closing a task also detaches the watcher before deleting the worker
conversation.

## Context finding

The reported annotation task was coordinated from the Clay repository
conversation, so it correctly inherited `/Users/bojansubotic/Desktop/clay`.
Coordinate is scoped to the current conversation/project; it does not yet route
work into another project automatically.

## Evidence

A regression test emits `done` twice and verifies one terminal task update.
The full suite passes: 355 tests, 0 failures.

## Status

DONE.
