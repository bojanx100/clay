# Project entry routing fix

## Symptom

Opening the Clay project through its ordinary project route selected the internal
`Project coordinator` conversation instead of an owner-facing Clay session. The
coordinator was deliberately omitted from the ordinary sidebar, yet it could
still become the default restored session.

## Root cause

The authoritative connection snapshot calls
`findRestoredActiveSession()` in `lib/project-connection-state.js`. Its ordinary
restore candidates excluded internal crafting loops but not lead-owned
`project_coordinator` sessions. A stored-presence record or recent activity
could therefore make that coordinator win default project entry.

This was inconsistent with `sidebar-sessions-model.js`, which already treats a
validated Coop-controlled project coordinator as internal for normal project
navigation. Exact SessionRef URLs take a separate, higher-precedence restore
path and must continue to reach the coordinator intentionally.

## Fix

Exclude validated Coop-controlled `project_coordinator` sessions only from the
ordinary default-restore candidate set. Exact session references still use the
explicit restore branch and retain their precedence.

## Evidence

The focused regression reproduces stored presence pointing to a coordinator:
ordinary entry selects the owner-facing session after the fix, while an exact
SessionRef selects the coordinator. Focused and relevant broader Node test
suites passed, as did `npm test`.

At a 1440 by 900 desktop viewport, the plain Clay route changed from
`Project coordinator - clay` before the repair to `VOICE - clay` afterward.
An explicit coordinator SessionRef continued to show `Project coordinator -
clay`; browser Back and Forward restored those two destinations respectively
without console errors.

## Status

Complete pending commit and push.
