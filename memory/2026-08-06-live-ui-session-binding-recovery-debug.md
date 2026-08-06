# Live UI session-binding recovery debug

Date: 2026-08-06
Status: Fixed

## Symptom

After Live UI had previously been connected to the Webapp `REDESIGN`
coordinator, the extension later returned to setup mode. The popup silently
selected the currently open `Multi-Repo Developer Contribution Analysis` chat
and reported:

> Start the session's local development server before opening Live UI

The Webapp page and Vite server were still running on `localhost:6075`, so the
message offered no usable recovery path.

## Root cause

The target was originally paired to the `REDESIGN` coordinator, whose persisted
active worktree is `v2/.worktrees/nexus-redesign-plan/webapp`. The live Vite
listener on port 6075 runs from that same directory.

When the server revoked a pairing, the extension deleted the only record that
contained the pinned project and session. A newly opened popup had no recovery
binding, so it defaulted to the current Clay chat. That unrelated chat resolves
to a different workspace root and correctly fails Clay's listener-ownership
check. The server was not stopped; the extension had lost the routing identity
needed to select its owner.

This is a state-recovery omission at the extension boundary, not a port-probe,
Vite, HMR, or target-page failure.

## Fix

- Successful pairings now retain a separate, credential-free recovery record in
  `chrome.storage.session` containing only target tab/origin and project/session
  display and routing identity.
- A server revocation removes the active pairing and its credentials while
  retaining that safe recovery record.
- Opening the popup on the same target tab restores the previous project and
  top-level chat before considering the currently open Clay chat.
- Explicit `Exit Live UI`, server unpair, target close, and origin change clear
  the recovery record intentionally.
- The old error copy is translated into an ownership-specific instruction:
  choose the chat that started the tab's server, or start the server there.
- Nonces, reconnect credentials, element selections, and pairing IDs never enter
  the recovery record.

## Evidence

- The reported target returns HTTP 200 at
  `http://localhost:6075/case/kofax/manage-tags`.
- Clay detects Webapp's configured Vite port as 6075.
- `portBelongsToDir(6075, nexus-redesign-plan/webapp)` returns `true`.
- The fail-first extension regression reproduced deletion of all routing state
  after a `live_ui_state: revoked` envelope. It now verifies the exact safe
  recovery payload and absence of all credentials.
- The extension picker regression verifies recovery metadata reaches the popup.
- The full extension suite passes 24/24 tests; syntax, whitespace, and module
  size checks pass.

## Regression tests

- `clay-chrome/test/live-ui-background.test.js`
- `clay-chrome/test/live-ui-picker-background.test.js`

## Related

- `2026-07-27-worktree-dev-port-ownership-debug.md` established that a session
  may claim an unmanaged server only when the listener process belongs to its
  bound workspace. This fix preserves that security boundary.
- `2026-08-06-live-ui-project-picker-debug.md` established project-first,
  top-level-chat selection and credential-storage constraints.
- `2026-08-06-live-ui-refresh-worker-snapshot-debug.md` fixed report snapshot
  rehydration after a target refresh. This incident occurred one layer earlier:
  the extension no longer knew which session to reconnect.

## Immediate recovery for the pre-fix pairing

The old pairing record had already been deleted before this fix existed. Select
`webapp` → `Coordinator · REDESIGN` once and start Live UI. Future revocations
within the same browser session restore that choice automatically. Reload the
unpacked extension once to activate this change.

## Follow-up: project and chat dropdowns required repeated attempts

### Symptom

Choosing either Project or Chat in the extension popup often took several
attempts before the selection remained in place.

### Root cause

The popup polls its background state every 750 ms. Every response called
`renderLiveUiOptions()`, which unconditionally cleared and recreated both native
`select` option lists even when the project/session data had not changed. A poll
response arriving during native dropdown interaction closed the menu or reset
its selected option. Clay's loop-lag and recovery canaries were healthy, so the
delay was not server-side UI lag.

### Fix and verification

- Picker option data now has a deterministic render signature. Identical poll
  responses do not touch either dropdown.
- The chat dropdown is never rebuilt while it owns focus.
- While the project dropdown owns focus, its DOM remains stable but newly loaded
  chats may populate the other dropdown; a later unfocused poll reconciles both.
- The fail-first popup contract regression requires both the unchanged-state
  signature guard and the focused-chat guard.
- The full extension suite passes 24/24 tests. Syntax, whitespace, module-size,
  and changed-function complexity checks pass.

Status: Fixed. Reload the unpacked extension once to activate the popup script.
