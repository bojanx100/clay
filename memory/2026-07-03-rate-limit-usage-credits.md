# Debug Report: Rate-Limit Usage Credits

- Symptom: When a provider rate-limit rejection reported extra usage credits/overage, Clay still created an automatic scheduled-message resume instead of continuing immediately.
- Root cause: `sdk-message-processor.js` detected `isUsingOverage`, but it still used `scheduleMessage(session, "continue", Date.now())`. `scheduleMessage()` always records a `scheduled_message_queued` item, which creates the scheduled-message bubble and scheduler behavior.
- Fix: Added a `continueWithUsageCredits()` path that dispatches the synthetic continue without scheduled-message records. The rate-limit processor now marks `rateLimitUseCreditsPending` while the rejected turn is still processing, and `sdk-bridge.js` fires it after query completion. The client skips auto-arming schedule mode when `isUsingOverage` is true.
- Evidence: `node --test test/rate-limit-credits.test.js` passed. `node --test test/auto-launch.test.js test/cli-sessions.test.js test/codex-adapter-routing.test.js test/connection-policy.test.js test/copilot-sessions.test.js test/effort-ultracode.test.js test/github-copilot-helpers.test.js test/pr-qa-verdict.test.js test/rate-limit-credits.test.js test/session-compaction.test.js test/session-persistence.test.js test/shutdown-socket-close.test.js` passed with 61 tests.
- Regression test: `test/rate-limit-credits.test.js`.
- Related: Full `node --test test/*.test.js` was interrupted because `test/security.test.js` hung; this appears unrelated because the excluding-security suite passed.
- Status: DONE_WITH_CONCERNS.

## Follow-up: Claude Monthly Spend Limit

- Symptom: Claude could emit "You've hit your org's monthly spend limit" after a normal five-hour `rate_limit` rejection had already queued an auto-continue, producing the wrong "waiting for provider" message and a scheduled resume even though extra usage credits were exhausted.
- Root cause: The spend-limit signal arrived as normal SDK text/tool output after the rate-limit event, not as a distinct `rate_limit_info` field, so Clay treated the earlier reset timestamp as actionable.
- Fix: `sdk-message-processor.js` now detects the monthly spend-limit text, cancels any queued scheduled resume, clears pending rate-limit auto-continue state, suppresses the raw provider text, and records one actionable warning.
- Evidence: `node --test test/rate-limit-credits.test.js` passed with the new monthly-spend regression. The non-security suite passed with 62 tests.

## Follow-up: Security Test Hang

- Symptom: `test/security.test.js` passed all assertions but kept the Node test runner alive until interrupted.
- Root cause: Importing `lib/server`/`lib/project` pulled in `lib/smtp.js`, which created a module-scope OTP cleanup interval without `unref()`.
- Fix: Store the SMTP OTP cleanup interval handle and call `unref()` when available.
- Evidence: `node --test test/security.test.js` exits cleanly, and the standard suite now includes it.
