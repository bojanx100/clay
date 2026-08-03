# Worker retry grouping debug report

- Symptom: Retrying one coordinator task created several same-title worker sessions. Only the latest attempt remained nested under the coordinator; prior attempts appeared as unrelated top-level chats.
- Root cause: `retry_task` correctly detaches the completed worker before creating a fresh attempt. Sidebar grouping relied only on the active `orchestrationParent`, so detachment discarded the UI's only ownership signal even though both the worker prompt and coordinator task graph retained the stable task ID.
- Fix: Session-list projection now joins detached workers back to their coordinator through the durable task ID without restoring active orchestration ownership. It exposes separate grouping-only metadata, numbers attempts chronologically, and renders all attempts below the coordinator as `Worker 1/N`, `Worker 2/N`, and so on on desktop and mobile.
- Evidence: The three persisted Urban Stay sessions 337, 338, and 339 project beneath coordinator 322 as attempts 1/3, 2/3, and 3/3. `node --test test/*.test.js` passed 529/529 tests.
- Regression test: `test/orchestration-task-state.test.js` covers detached retry ownership and chronological attempt numbering. `test/mobile-coordinator-grouping.test.js` covers grouping-only parent metadata and attempt labels.
- Related: Earlier fixes restored the latest completed worker's nesting after restart and kept coordinator groups expanded, but did not preserve grouping for prior retry attempts.
- Status: DONE
