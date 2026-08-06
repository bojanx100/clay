# Live UI capture viewport shift debug

Date: 2026-08-06
Status: Fixed in `clay-chrome` commit `2e4d8b8`

## Symptom

Submitting a Live UI report visibly moved the page and repeatedly returned:

> The page moved during capture. Try the report again.

## Root cause

The target overlay measured the viewport and privacy-mask rectangles before asking
the extension for a screenshot. The extension then attached Chrome Debugger and
used `Page.captureScreenshot`. Chrome displayed its debugger notification bar,
which reduced the page viewport height. The post-capture safety check correctly
detected that the screenshot dimensions no longer matched the earlier masks and
discarded the screenshot.

This was deterministic extension-induced movement, not user scrolling, React
HMR, the Clay relay, or daemon latency.

## Five whys

1. The report failed because the capture safety check found a viewport mismatch.
2. The viewport mismatched because its height changed during capture.
3. Its height changed because the extension attached Chrome Debugger.
4. The debugger was attached after the target measured screenshot masks.
5. The implementation chose debugger-backed capture without accounting for the
   debugger notification bar resizing the viewport.

## Fix

`live-ui-evidence.js` now captures the visible target tab through
`chrome.tabs.captureVisibleTab`, avoiding debugger attachment and its layout
shift. It verifies that the paired target tab is active both before and after
capture, then preserves the exact document-generation, viewport-size, and scroll
position checks before applying masks. Real page movement is still rejected.

## Regression proof

The focused regression first simulated the prior behavior: attaching the debugger
changed a stable viewport from 1200x800 to 1200x760, and the old implementation
failed with the reported error. After the fix, the same stable capture succeeds
without a debugger attachment. The test also changes the real post-capture height
to 799 and confirms that the safety guard still rejects it.

Verification in `clay-chrome`:

- `node --test test/*.test.js`: 22 passed, 0 failed.
- Syntax checks passed for all root and test JavaScript files.
- `git diff --check` passed.
- Live UI extension modules remain below 500 lines.
- No debugger capture calls remain in `live-ui-evidence.js`.

## Operational note

Reload the unpacked Clay extension in `chrome://extensions` to activate the fix.
The Clay daemon does not need to restart.
