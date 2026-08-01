# Keep Awake clamshell support

## Debug report

- **Symptom:** Clay's Keep Awake toggle did not keep a Mac reachable after closing the lid.
- **Root cause:** Clay launched `caffeinate -di`, which asserted display and idle-sleep prevention only. macOS documents that idle assertions may still allow sleep on lid close.
- **Fix:** Clay now launches `/usr/bin/caffeinate -dis`. The `-s` assertion prevents system sleep while connected to AC power, matching the existing AC-only clamshell helper script without changing global `pmset` state or requiring administrator access. Process ownership and cleanup moved into `lib/keep-awake.js`.
- **Evidence:** A live `/usr/bin/caffeinate -s -t 3` probe produced `PreventSystemSleep 1` in `pmset -g assertions` and released it after the process exited.
- **Regression test:** `test/keep-awake.test.js` verifies the exact macOS assertion flags, single-process lifecycle, cleanup/restart, and non-macOS no-op behavior.
- **Related:** The prior daemon implementation already cleaned up `caffeinate` on graceful and last-resort exit; the controller preserves both paths and clears stale process references on child exit/error.
- **Status:** DONE
