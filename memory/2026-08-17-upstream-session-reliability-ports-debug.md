# Debug report: upstream session reliability ports

Date: 2026-08-17

## Symptom

- A user message could show processing but never reach a provider when it arrived while a query handle was starting or when processing state outlived its consumer.
- Claude adaptive thinking and Codex summarized reasoning could execute without readable thinking text in Clay.
- Automatically adopted external Claude CLI sessions could raise Clay banners even though no Clay terminal owned the session.

## Root cause

- `sdk-bridge.pushMessage()` returned no delivery result and silently discarded text without a live handle. Query startup exposed no boot-window state or ordered backlog, while `project-user-message-queue` assumed the push succeeded.
- Claude query options omitted an explicit summarized display for adaptive thinking. Codex only normalized completed reasoning items, while readable summaries arrive through `item/reasoning/*Delta` notifications.
- CLI import did not distinguish automatic orphan adoption from explicit user import. That provenance was not persisted, and neither TUI notification path checked whether an adopted session had a Clay terminal.

## Fix

- Query startup now marks `_queryStarting`, buffers `pendingPush` messages, flushes them in order before single-turn input closes, clears failed-start backlogs, and reports whether `pushMessage()` found a consumer. User-message dispatch starts a fresh query when delivery explicitly fails.
- Claude adaptive thinking now requests `{ type: "adaptive", display: "summarized" }`. Codex reasoning delta and summary-part notifications normalize into thinking lifecycle events while tracking streamed length to avoid duplicate completed text.
- Automatic orphan adoption records `adopted: true`; explicit import remains non-adopted. The flag survives restart, and both TUI notification emitters suppress only adopted sessions without a Clay terminal.

## Evidence

- Regression tests were written first and failed against the old behavior.
- Focused combined verification passed 58/58 tests after implementation.
- Full `npm test` passed 2,795/2,795 tests with 0 failures.
- `git diff --check` and syntax checks for all changed production modules passed.
- The post-verification diagnostics window returned to 2-29 ms loop-lag maxima with no `SAVE-FAIL`, `WS-HANDLER-ERROR`, watchdog, or recovery-loop entries. Earlier 12:33-12:34 lag/save markers predated the quiet window and were unrelated to these provider-delivery paths.

## Regression tests

- `test/project-user-message-queue.test.js`
- `test/provider-agent-pipeline.test.js`
- `test/sdk-query-thinking.test.js`
- `test/codex-adapter-routing.test.js`
- `test/cli-sessions.test.js`
- `test/session-persistence.test.js`
- `test/server-tui-hooks.test.js`

## Related

- Upstream commits: `40d537e94b`, `5b04241e07`, and `38c53a16d7`.
- The fork-specific explicit-import distinction prevents a user-requested import from being treated as unattended external activity.
- Codex reasoning normalization was placed in the existing rich-event helper so `codex-events.js` remains below the project's 500-line module limit.

## Status

DONE
