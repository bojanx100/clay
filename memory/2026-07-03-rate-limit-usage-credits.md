# Debug Report: Rate-Limit Usage Credits

- Symptom: When a provider rate-limit rejection reported extra usage credits/overage, Clay still created an automatic scheduled-message resume instead of continuing immediately.
- Root cause: `sdk-message-processor.js` detected `isUsingOverage`, but it still used `scheduleMessage(session, "continue", Date.now())`. `scheduleMessage()` always records a `scheduled_message_queued` item, which creates the scheduled-message bubble and scheduler behavior.
- Fix: Added a `continueWithUsageCredits()` path that dispatches the synthetic continue without scheduled-message records. The rate-limit processor now marks `rateLimitUseCreditsPending` while the rejected turn is still processing, and `sdk-bridge.js` fires it after query completion. The client skips auto-arming schedule mode when `isUsingOverage` is true.
- Evidence: `node --test test/rate-limit-credits.test.js` passed. `node --test test/auto-launch.test.js test/cli-sessions.test.js test/codex-adapter-routing.test.js test/connection-policy.test.js test/copilot-sessions.test.js test/effort-ultracode.test.js test/github-copilot-helpers.test.js test/pr-qa-verdict.test.js test/rate-limit-credits.test.js test/session-compaction.test.js test/session-persistence.test.js test/shutdown-socket-close.test.js` passed with 61 tests.
- Regression test: `test/rate-limit-credits.test.js`.
- Related: Full `node --test test/*.test.js` was interrupted because `test/security.test.js` hung; this appears unrelated because the excluding-security suite passed.
- Status: DONE_WITH_CONCERNS.
