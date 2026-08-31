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

## Revision 2 correction

The approved revision-2 scope was not covered by the revision-1 fix. The
Workspace header rendered its Refresh control and registered its click handler
unconditionally. In owner Workspace the handler only re-rendered the cached
owner ledger; it did not request authoritative state, so it was misleading.
Also, owner-ledger rerenders replace the group status and collapse/expand icon
nodes after the generic Workspace path has returned, but did not call the
Lucide hydrator.

The owner-specific renderer now synchronizes the header button to hidden and
disabled, with a handler guard as a defence in depth. Generic Workspace keeps
the enabled button and its existing `workspace_get` request behavior. The
owner renderer calls `refreshIcons()` after every ledger mount, covering
projection updates, empty-to-nonempty groups, and collapsed/expanded groups.

The focused regression in `test/workspace-panel-state.test.js` covers owner
Refresh removal, generic Refresh preservation, icon hydration after an
empty-to-nonempty update, collapse and expand rerenders, and an authoritative
post-reconnect projection. With only the revision-2 production code reverted,
that file reported 8 passing and 1 failing test; after restoration it reported
9 passing and 0 failing. The focused and adjacent Workspace/owner/worktree
suite reported 37 passing and 0 failing, including the revision-1
request-correlation and initial-project-icon tests.

The full `npm test` runner was started but did not complete: it reported two
missing runtime packages in the isolated worktree, then remained stalled for
more than nine minutes in the unrelated `coop-control-sdk-fence` test. A
separate concurrent clean-worktree full run was stalled in that same test.
No control-fence or dependency changes were made because they are outside the
owner-approved Workspace revision-2 scope.
