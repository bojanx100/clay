# Lead Global Space — design proposal

Status: PROPOSED (awaiting boss approval)
Relates to: [CTO-ORCHESTRATOR-ROADMAP.md](CTO-ORCHESTRATOR-ROADMAP.md)

## Problem

The Lead (CTO orchestrator) conceptually sits **above** all projects: it
ingests backlogs across repos, staffs workers anywhere, and reports one
standup. But today it lives as an ordinary chat session inside the clay
project — found by scrolling a project's session list, mixed in with the
worker sessions it manages. The boss put it plainly: *"it's a bit silly to
have to talk to lead from a chat... it should be a global space."*

Concrete pains:

- The Lead conversation is one of many rows in one project's session list.
- Standups land wherever the session happens to live.
- Worker updates can only reach the Lead when workers run in the same
  project (`sendToSession` routes within a single project context,
  `lib/project-connection.js`) — cross-project staffing has no way to
  report back.

## Precedent: Mates are pseudo-projects

Clay already solved "a conversation that is not a project": **Mates**.

- A Mate registers as a pseudo-project with slug `mate-<id>` via
  `addProject()` (`lib/server-mates.js:85`, `lib/daemon.js:1142`), giving
  it a WS scope (`/p/mate-<id>/ws`) and a session manager for free.
- Its identity/storage lives globally under `~/.clay/mates/`, not under a
  project cwd (`lib/mates.js:14-20`).
- The project record carries an `isMate: true` flag (`lib/server.js:992`)
  and the UI surfaces Mates in a dedicated strip (`sidebar-mates.js`),
  not in the project session list.

The Lead is the same shape: a persistent agent conversation with global
identity. It should ride the same rails.

## Proposal

### Slice 1 — Lead as a pseudo-project (backend) — SHIPPED

- Register slug `lead` at daemon boot via `addProject()`, flagged
  `isLead: true`, exactly as Mates do. WS scope: `/p/lead/ws`.
- The Lead's working cwd stays the clay repo checkout (it needs the lead
  modules and scripts on disk), but its *identity* is the daemon-level
  registration, not the project session list.
- State stays where it already is: `~/.clay/lead/` (ledger, items,
  baselines) — already global, no migration.
- The Lead session inside the pseudo-project runs the `lead-tick` skill
  as today; the two cron schedules re-point `linkedTaskId` at the new
  scope (one-line change per record in the loop registry).

### Slice 2 — Sidebar surface (frontend) — SHIPPED

- Desktop: a pinned "Lead" entry ABOVE the projects panel (or first in
  the Mates strip with a distinct badge) — one click, no scrolling.
- Mobile: same entry pinned at the top of the coordinators sheet
  (`sidebar-mobile-coordinators.js` already builds coordinator groups).
- Standups render in the Lead space; a small unread badge when a new
  standup or approval request lands.

### Slice 3 — Cross-project worker updates (the real gap)

- Today `[Clay worker update]` injection is same-project only
  (`lib/project-task-orchestrator.js:113-130`).
- Add a daemon-level router: when a worker's coordinator lives in another
  scope, look up the target context in the `projects` Map by slug
  (`lib/server.js:168`) and call that context's `sendToSession`.
- This unlocks the roadmap's cross-repo staffing: Lead staffs a worker in
  webapp's checkout; the result routes back to `/p/lead`.

### Non-goals

- No new storage format; no session migration (the existing Lead session
  history can stay in the clay project as archive).
- No multi-user Lead (single-boss assumption holds until Phase 4).
- No change to the kill switch, approval rules, or ledger semantics.

## Sequencing and risk

| Slice | Size | Risk | Depends on |
|-------|------|------|------------|
| 1 backend pseudo-project | S — follows the Mate path | low | — |
| 2 sidebar surface | M — UI in 2 places | low | 1 |
| 3 cross-project updates | M — new daemon router | medium (message loss on bad slug → needs a dead-letter log line) | 1 |

Slice 1 is shippable alone (the space exists, reachable by URL); 2 makes
it discoverable; 3 makes cross-repo staffing real. All three are
SELF-MODIFICATION items under the lead-tick skill rules: approval-class,
staffed one slice per worker with the full gate.
