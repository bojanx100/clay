# Workspace refresh and project-icon hydration — 2026-08-31

## Symptom

Workspace could display stale or incomplete context after a manual refresh, and
the title bar had no current-project icon until the full projects list arrived.

## Root cause

Workspace sends a local skeleton followed by asynchronous GitHub enrichment but
did not correlate those two responses to a particular request. A slower older
enrichment could therefore overwrite a newer manual refresh for the same
session. Separately, the initial `info` snapshot did not contain the current
project icon, so the title bar had to wait for a later project-list render.

## Fix

- Client requests now carry a monotonic `requestId`; the server echoes it on
  both Workspace phases and errors, and the client drops stale responses.
- The connection `info` snapshot now carries the authoritative project icon.
  The title-bar identity resolver uses it immediately, then continues to prefer
  the parent/project descriptor from the hydrated project list.

## Evidence

`test/workspace-panel-state.test.js` sends two real panel requests and proves a
late older response cannot replace the newer render. `test/worktree-family.test.js`
proves the initial icon fallback and parent-worktree identity. With the response
guard reverted, the Workspace test file reports 6 passing and 2 failing tests;
with the icon fallback removed, the icon test reports 0 passing and 1 failing.
After restoration, focused, adjacent, and full project tests passed.
