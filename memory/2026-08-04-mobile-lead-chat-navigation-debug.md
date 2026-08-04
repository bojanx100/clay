# Mobile Lead chat navigation debug report

- **Symptom:** The mobile Chat sheet showed ordinary project chips but no pinned Coop/Lead entry.
- **Root cause:** `renderSheetSessions()` built its project chips with `groupProjects()`. That helper intentionally excludes the Lead pseudo-project so desktop and project-list renderers can place it separately, but the mobile Chat renderer did not add it back.
- **Fix:** Insert the detected Lead project before ordinary mobile Chat project chips, render the existing Coop name with a visible Lead badge, and add compact mobile styling for the special chip.
- **Evidence:** At a 375x812 viewport, the live dev app rendered `Coop / Lead` first in the Chat filter. Tapping it navigated to `/p/lead/`, and the browser console remained clean.
- **Regression test:** `test/mobile-lead-navigation.test.js` fails when the mobile Chat renderer omits the Lead chip and passes with the fix.
- **Test results:** The focused mobile/Lead suite passes 12/12. The repository-wide suite passes 619/620; the one failure is an unrelated source assertion in `test/orchestration-task-layout.test.js` caused by the pre-existing uncommitted `sidebar-sessions.js` refactor renaming `orchestrationParent` to `parent`.
- **Related:** Commit `ac1ece90d3` pinned Lead in desktop navigation and the mobile Projects sheet but omitted the mobile Chat filter shown in the report.
- **Status:** DONE_WITH_CONCERNS — the reported mobile flow is fixed and verified; the unrelated uncommitted sidebar refactor leaves one full-suite failure.
