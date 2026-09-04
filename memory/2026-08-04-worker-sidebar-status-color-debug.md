# Worker sidebar status color debug report

- Symptom: A completed worker appeared green in the coordinator preview but could appear red or provider-colored in the sidebar.
- Root cause: The preview rendered the coordinator task's authoritative `status`, while the session-list projection omitted that field. The sidebar therefore used a deterministic worker identity color for its rail and badge, plus a provider color for its dot; one valid identity color is red, which incorrectly read as failure.
- Fix: Session-list grouping now projects task status to the active worker. Sidebar rows, worker badges, and dots render from the shared task-state palette, and task status transitions broadcast a fresh session list so the color cannot remain stale.
- Evidence: Focused orchestration and grouping tests pass 47/47, the full suite passes 570/570, syntax checks pass, and the completed-state CSS maps the sidebar row and dot to `var(--success)`.
- Regression test: `test/orchestration-task-state.test.js` verifies completed task status reaches sidebar grouping. `test/orchestration-task-layout.test.js` verifies the completed color mapping and status-change broadcast.
- Related: Worker identity colors remain as a fallback for sessions without coordinator task status.
- Status: DONE
