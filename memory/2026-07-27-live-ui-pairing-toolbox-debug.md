# Live UI pairing and toolbox debug report

## Symptom

- The target overlay remained on “Connecting to Clay…” indefinitely.
- A selected element was outlined, but the toolbox did not clearly confirm what
  was selected.
- Toolbox interactions could escape into the target application.
- The fixed bottom-right toolbox could cover the element being reviewed.

## Root cause

The server correctly sent the authoritative `live_ui_state` message after the
target proved its pairing. That message used the pinned session's durable
storage ID. Clay's generic client message filter compared every `sessionId`
against the numeric active-session ID and discarded the Live UI lifecycle
before it reached the extension bridge.

The toolbox used a closed shadow root for styling, but did not stop composed
events at the shadow boundary. Its selection controller also retained the last
hover target while the pointer moved over the toolbox, and the UI displayed the
element name without labeling it as a confirmed selection.

## Fix

- Route Live UI messages before active-session stale-message filtering.
- Add explicit `Selected: …` state and an expanded selected-element confirmation.
- Reset transient hover state when the pointer enters the toolbox or selection
  mode is cancelled.
- Stop composed toolbox events at the shadow boundary.
- Add a drag grip with viewport clamping.
- Replace an endless connecting state with a bounded timeout and actionable
  connection error.
- Split target context and UI responsibilities into bounded extension modules.

## Evidence

- The lifecycle-order regression test failed before the routing change and
  passes after it.
- All 12 extension tests pass.
- All 443 Clay tests pass.
- Extension scripts parse successfully, the manifest parses, and all edited
  extension modules remain below 500 lines.
- Recovery and performance canaries were healthy before implementation.

## Regression tests

- `test/live-ui-client-contract.test.js`
- `clay-chrome/test/live-ui-background.test.js`

## Status

DONE_WITH_CONCERNS: automated verification is complete, but the connected
browser surface was unavailable for screenshot-based visual verification. A
manual extension reload and target-tab reload are required to activate the new
content scripts.
