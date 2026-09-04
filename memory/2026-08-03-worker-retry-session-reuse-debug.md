# Worker retry session reuse debug report

- Symptom: Three review passes for one coordinator task created three worker conversations with the same title, even though each prior worker completed normally and remained healthy.
- Root cause: The completed-task guard correctly required `retry_task`, but `retry_task` unconditionally detached the current worker, cleared its session IDs, and scheduled a new worker. It made no distinction between a healthy follow-up pass and a failed/unavailable worker that needed clean context.
- Fix: Safe retries for completed, reviewing, and needs-input tasks now continue the idle owned worker conversation, increment the task attempt, reset result state, restore the completion watcher, and send a current-input retry instruction. Failed, stopped, hidden, processing, detached, or unavailable workers still use the fresh-session path. Coordinators can explicitly request `freshSession: true` when an independent context is genuinely required.
- Evidence: The regression executes three completed passes while retaining one worker session and reaching attempt 3. Separate tests prove failed tasks and explicit independent passes still create fresh workers. `node --test test/*.test.js` is the full verification command.
- Regression test: `test/project-task-orchestrator.test.js` covers three-pass reuse, failed-task fallback, and explicit fresh-session behavior.
- Related: `2026-08-03-worker-retry-grouping-debug.md` preserves historical grouping for the fresh sessions that are still necessary.
- Status: DONE
