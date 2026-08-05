# DEBUG REPORT

- **Symptom:** Clay's CLI import picker listed hidden Clay orchestration workers as standalone import choices.
- **Root cause:** `listAdoptableCliSessions` excluded hidden sessions from `knownCliIds`, then deliberately reintroduced them through vendor scans and the hidden-session fallback. It had no separate set for provider IDs belonging to sessions with `orchestrationParent`, and did not recognize hidden non-coordinator sessions with valid `coopControlledBy` provenance.
- **Fix:** `lib/sessions-cli-import.js` now collects current, storage, and historical provider IDs from orchestration workers and hidden non-coordinator Coop-controlled sessions, excluding them from Claude, Codex, GitHub Copilot, and hidden-fallback candidates. Hidden coordinators, hidden user-created direct sessions, and untracked external descriptors remain eligible.
- **Evidence:** The regression test first failed with four listed orchestration worker IDs, then the refined fixture failed with `coop-controlled-leaf` on the prior commit. It now passes. Scoped CLI/session-persistence tests pass 26/26.
- **Regression test:** `test/cli-sessions.test.js` — `orchestration workers stay out of every CLI import candidate path`.
- **Related:** The hidden-session fallback behavior was introduced by `735d674205` to restore closed/archived sessions; the worker exclusion preserves that recovery behavior for non-worker records.
- **Status:** DONE — refined focused regression and full suite pass.
