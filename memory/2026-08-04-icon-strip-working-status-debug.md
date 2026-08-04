# DEBUG REPORT

- **Symptom:** A selected project, worktree, or Mate showed a green status dot even when it was idle.
- **Root cause:** `icon-strip.css` made `.icon-strip-status` visible for every active project, worktree, and Mate. The connection state added `.connected`, which colored that selection-driven dot green even without `.processing`.
- **Fix:** Removed active-selection visibility rules. The dot is now revealed by `.processing` for active work or `.io` for an I/O flash.
- **Evidence:** Browser computed-style verification returned opacity `0` for a selected connected idle icon and opacity `1` for the same icon with `.processing`. The isolated visual fixture showed the dot only on the working icon. The full automated suite passed: 605 tests, 0 failures.
- **Regression test:** `test/icon-strip-status.test.js` asserts selection cannot reveal the dot and processing still does.
- **Related:** The behavior came from the original connection/status-dot styling rather than a recent regression. Project, worktree, and Mate selectors shared the same selection/work-state coupling.
- **Status:** DONE
