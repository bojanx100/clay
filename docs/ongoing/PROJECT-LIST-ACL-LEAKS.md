# Project list ACL leaks

Status: **open, not fixed**
Found: 2026-08-07, during `clay-mobile-project-switcher-regression`
Severity: information disclosure (project existence, slug, path, owner id). No write access is granted by any of these.

Three server-side paths broadcast the project list without applying the per-user
ACL filter. All three predate the mobile project-switcher work and affect the
**desktop icon strip identically** — the mobile switcher restored in that task
renders the same `getCachedProjectList()` the desktop strip has always rendered,
so it neither introduced nor widened any of them.

They were deliberately left unfixed there: the fix surface is server-side
(`lib/server.js`, `lib/daemon.js`, `lib/project-status.js`), outside that task's
owned client-display paths, and folding a security change into a mobile
navigation commit would have made both harder to review and to revert.

---

## 1. Unfiltered `info` broadcast on project rename

`lib/project-status.js:83` — `setTitle()` calls `getProjectList()` with **no
`userId`**, so the ACL branch inside it is skipped entirely:

```js
function setTitle(newTitle) {
  title = newTitle || null;
  send({
    type: "info",
    ...
    projects: getProjectList(),   // <-- no userId
```

`send()` fans out to every client of that project (`lib/project-clients.js:6-11`).

**Effect:** renaming any project pushes the full, unfiltered project list —
slug, path, title, `projectOwnerId` — to every connected client, including users
with no access to most of those projects.

**Fix sketch:** `setTitle` has no user context today. Either thread the per-client
user id through the broadcast (as `broadcastProcessingChange` at
`lib/server.js:983-991` already does), or stop shipping `projects` in the
rename-triggered `info` frame and let the existing `projects_updated` path carry it.

## 2. Unfiltered `projects_updated` broadcast on worktree creation

`lib/daemon.js:1136-1140`:

```js
relay.broadcastAll({ type: "projects_updated", projects: relay.getProjects(), ... });
```

`getProjects()` (`lib/server.js:1331-1337`) is unfiltered, and `broadcastAll`
(`lib/server.js:1472-1476`) reaches all clients of all projects.

**Fix sketch:** route through `broadcastProjectsUpdated` (`lib/server.js:1434-1445`),
which is already per-user filtered and memoized.

## 3. Worktrees are never ACL-filtered (the reliable one)

All three filter sites call `onGetProjectAccess(slug)` with the **worktree's own**
slug (e.g. `foo--branch`). Worktrees are not in `config.projects` — they are
registered only via `relay.addProject` (`lib/daemon.js:1135`) — so
`onGetProjectAccess` returns `{ error: "Project not found" }`
(`lib/daemon.js:1097`). Every guard is written as:

```js
if (access && !access.error && !users.canAccessProject(userId, access)) return;
```

The `!access.error` clause means a not-found lookup **falls through and the entry
is included**. A worktree of a project the user has no ACL for is therefore listed
for them.

Two other call sites get this right by resolving to the parent first — the WS
upgrade (`lib/server.js:853-855`) and `canAccessProjectRef` (`lib/server.js:1255`):

```js
var accessSlug = (wsSlug.indexOf("--") !== -1) ? wsSlug.split("--")[0] : wsSlug;
```

**Net effect today:** the worktree is *listed* but not *openable* — the WS upgrade
resolves to the parent slug and returns 403. So this is disclosure, not access.

**Fix sketch:** apply the same parent-slug resolution in `getProjectList`,
`broadcastProcessingChange`, and `broadcastProjectsUpdated`. Consider also making
the guards fail **closed** on `access.error` rather than open, but check first
whether any legitimate project reaches those paths without an access record —
failing closed naively would hide worktrees from users who should see them.

---

## Related: a denied project switch fails silently

Not an ACL hole, but the same area and it makes hole #3 user-visible as a hang
rather than an error.

`switchProject()` (`lib/public/modules/app-projects.js:279-324`) does no
permission check — it sets `currentSlug`/`basePath`/`wsPath`, pushes history, and
calls `connect()`. When the server answers the upgrade with 403
(`lib/server.js:850-864`), the client's `onerror` is empty
(`lib/public/modules/app-connection.js:315`) and `onclose` just calls
`scheduleReconnect()` (lines 306-313).

**Effect:** the owner taps a project they cannot open, the UI moves to it, and
then reconnects forever with no error shown and the URL already changed.

**Fix sketch:** capture the 403 (the close code / a pre-flight HTTP probe) and
surface it, then restore the previous slug instead of retrying.

---

## Verification notes

- ACL predicate: `lib/users-permissions.js:66-77` (public → all; admin → all;
  owner → always; else `allowedUsers` membership).
- Access records: `lib/daemon.js:1078-1098`. The `lead`/Coop project is
  synthesized at 1079-1086 as `visibility: "private", allowedUsers: []`, so only
  the lead owner and admins pass.
- The correctly-filtered paths, for reference: `getProjectList(userId)`
  (`lib/server.js:1048-1059`), `broadcastProcessingChange`
  (`lib/server.js:983-991`), `broadcastProjectsUpdated` (`lib/server.js:1434-1445`).
- `worktreeAccessible` is **not** an ACL concept — it is a filesystem containment
  check (`lib/worktree.js:54`: is the worktree dir inside the parent dir?). The
  client's `worktreeAccessible !== false` handling is cosmetic and must not be
  mistaken for a permission gate.
