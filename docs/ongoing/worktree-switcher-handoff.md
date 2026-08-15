# Handoff: worktrees as branches inside a project (stage 1: title-bar switcher)

**Status:** proposed / ready to implement
**Author:** handoff from Chad + Claude, 2026-08-16
**Branch:** start from `main`
**Decision (Chad, 2026-08-16):** worktrees should feel like something INSIDE
one project, not sibling projects. Stage 1 keeps the per-worktree project
context untouched and changes only the presentation: a branch switcher chip
in the title bar replaces the worktree folder in the project strip.

---

## Mission

Today a worktree is registered as a separate project (own slug
`<parent>--<dir>`, own context) and rendered in the project icon strip as a
collapsible folder under its parent. Clicking one navigates the whole app to
"another project": different icon identity, different session list, no sense
of "same repo, different branch".

Stage 1 turns the presentation into a branch model:

1. Worktrees disappear from the project icon strip entirely.
2. The title bar gains a branch chip: `⎇ <branch> ▾`. Its dropdown lists
   main + all worktrees of the current project family, switches between
   them, and offers "New worktree".
3. While a worktree is current, the title bar keeps the PARENT's name and
   icon; only the chip changes. Switching reads as changing branches, not
   leaving the project.

Explicitly out of scope (stage 2, do not build): aggregating worktree
sessions into the parent's session list, spawn-into-worktree, any change to
project contexts, slugs, URLs, or the daemon registry.

## Constraints

- Root `CLAUDE.md` rules apply: `var`, no arrow functions, client modules
  are ES modules, state in `store.js`, no `var _ctx` patterns, English
  comments/commits, Angular commits, no commit/push/PR without Chad's
  approval, and **no localStorage for user state** (this handoff deletes one
  existing violation, see 3f).
- Keep green: `npm test`, both syntax sweeps, `node scripts/check-client-imports.js`.

---

## Verified current state (all file:line checked 2026-08-16)

| Fact | Where |
|---|---|
| Worktree slug = `parentSlug + "--" + dirName`; registered as a project whose display name is the branch, icon inherited from parent | `lib/daemon-projects.js:34-43` |
| Client project objects already carry everything the chip needs: `isWorktree`, `parentSlug`, `branch`, `worktreeAccessible`, `isProcessing`, `unread`, `pendingPermissions`, `onlineUsers` | `lib/public/modules/app-projects.js:315-325` |
| Project strip renders a collapsible parent+worktrees folder (chevron, per-family processing/pending aggregation) | `lib/public/modules/sidebar-projects.js:963-1330` (`groupProjects`, folder render, aggregation at `:1218` and `:1329`) |
| Folder collapse state persisted in localStorage (`clay-wt-collapsed`) | `sidebar-projects.js:34-37, 956-960` |
| Title bar: `#title-bar-project-dropdown` holds `#title-bar-project-icon` + `#title-bar-project-name` + chevron | `lib/public/index.html:207-211`; name updated from `app-projects.js:335` and `app-messages.js:85,299,308`; dropdown behavior in `sidebar-projects.js:290,790` |
| Project switching entry point | `app-projects.js:409` `switchProject(slug)` |
| "Add Worktree" context-menu item on parent projects; modal `showWorktreeModal(parentSlug, parentName)` fetches `/p/<slug>/api/branches`, sends `create_worktree`, handles `create_worktree_result` | `sidebar-projects.js:530,626-633,1040-1160` |
| "Remove Worktree" context-menu item on worktree strip items; delete flow shows confirm, sends `delete_project`, toasts "Worktree removed" | `sidebar-projects.js:503-518`, `app-projects.js:480,561-598` |
| Cmd-K project switcher lists worktrees and disables unreachable ones; command palette already skips worktrees | `project-switcher.js:260-310`, `command-palette.js:351` |

No server changes are needed for stage 1. The `projects` payload (`info`
message) already contains the family structure.

---

## Implementation

### 3a. Family helper (client)

In `app-projects.js` (or a small helper in `sidebar-projects.js`), derive
from the cached projects list:

```js
// familyOf(slug): { parent, worktrees: [...] } where parent is the non-wt
// project and worktrees are its children, using isWorktree/parentSlug.
// For a worktree slug, resolve through parentSlug first.
```

`currentFamily()` = family of `store.currentSlug`. The chip and strip both
render from this.

### 3b. Project strip: remove the worktree folder

In `sidebar-projects.js` strip rendering (`:1190-1330`):

- Render parents only; drop the folder wrapper, chevron, and child rows.
- KEEP the family aggregation: the parent icon's processing dot, unread,
  and pending-permission badges must include its worktrees (the aggregation
  loops at `:1218` and `:1329` already compute this; reattach them to the
  single parent icon).
- When the current project IS a worktree, mark the PARENT icon active in
  the strip (`renderIconStrip` active-slug logic at `app-projects.js:328`
  area: map a worktree currentSlug to its parentSlug for highlighting).

### 3c. Title bar: branch chip

`lib/public/index.html` next to `#title-bar-project-dropdown` (inside
`.title-bar-sidebar`):

```html
<button id="branch-chip" class="hidden">
  <i data-lucide="git-branch"></i>
  <span id="branch-chip-label"></span>
  <i data-lucide="chevron-down"></i>
</button>
<div id="branch-chip-menu" class="hidden"></div>
```

Behavior (new client module `lib/public/modules/branch-switcher.js`, wired
from `app.js`; keep it under 200 lines):

- Visibility: show the chip when `currentFamily().worktrees.length > 0`,
  or when the current project is itself a worktree. Hide in DM/mate mode
  (same gating the vendor toggle uses) and on the home hub.
- Label: current branch. For the parent project the branch is not in the
  payload; label it `main` only if cheap to know, otherwise use the repo's
  actual default branch via the existing `/api/branches` route's
  `headRef`... do NOT guess: `showWorktreeModal` already fetches
  `/p/<slug>/api/branches` (`sidebar-projects.js:1085`) and the route
  resolves `origin/HEAD` (`project-http.js:667-673`). Reuse that (cache per
  slug). If the fetch fails, label the parent entry "default".
- Dropdown rows: parent first, then worktrees sorted by name. Each row:
  `⎇ branch`, processing dot / pending badge (data from the projects
  payload), disabled state for `worktreeAccessible === false` with the same
  tooltip the strip used (`project-switcher.js:260-263` has the wording).
  Current row checkmarked.
- Row click: `switchProject(slug)` — nothing else. The illusion work is 3d.
- Footer row: `+ New worktree...` opens the existing
  `showWorktreeModal(parentSlug, parentName)` (export it from
  sidebar-projects.js if not already).
- Per-row overflow action (or right-click, matching strip conventions):
  `Remove worktree` for worktree rows, reusing the existing confirm +
  `delete_project` flow from `app-projects.js:480`. This action currently
  lives on the strip items that are being deleted, so it MUST move here or
  worktree removal becomes unreachable from the UI.
- Close on outside click like other popovers (see `session-ctx-menu`
  document click pattern in `sidebar-sessions.js:492-495`).

### 3d. Identity illusion while inside a worktree

When `currentSlug` is a worktree:

- `#title-bar-project-name` shows the PARENT project's name, not the
  branch. The three writers of that element (`app-projects.js:335`,
  `app-messages.js:85,299,308`) must route through one helper (put it in
  app-projects.js) that resolves worktree -> parent name; the branch lives
  in the chip. Same for `#title-bar-project-icon`.
- Everything else (sessions, file browser, chat) keeps pointing at the
  worktree project context exactly as today. No behavioral change.

### 3e. Keyboard/switcher surfaces

- `project-switcher.js`: keep worktrees listed (keyboard users need a path)
  but label rows `parentName ⎇ branch` instead of the bare branch name.
- `command-palette.js:351` already skips worktrees; leave it.

### 3f. Delete the localStorage collapse state

`sidebar-projects.js:34-37` and `:956-960` (`clay-wt-collapsed`) become
dead with the folder UI; remove them. This also clears an existing
violation of the no-localStorage rule. Do not migrate the stored value;
it is presentation-only.

### 3g. Mobile

The mobile project sheet lists projects via `sidebar-mobile.js`. Stage 1
scope: hide worktree entries from the mobile project list the same way as
the strip, and add the family aggregation to the parent row. A mobile
branch switcher is a follow-up; note it in the PR description rather than
building it.

---

## Edge cases (handle explicitly)

1. **Worktree removed while you are in it**: the existing delete flow
   already handles navigation on `project_deleted` (`app-projects.js:561-598`,
   which knows the `--` slug convention); verify it lands you on the parent
   and the chip updates. Fix in place if it strands you.
2. **Worktree becomes inaccessible** (parent moved): disabled dropdown row,
   same as the switcher today.
3. **No worktrees**: chip hidden entirely; "Add Worktree" stays available
   in the project context menu, and the chip appears after the first
   worktree registers (the daemon rescan interval, `daemon-projects.js:45-48`,
   pushes an updated projects list; verify the chip appears without reload).
4. **Multi-user**: worktree projects inherit parentOwnerId at registration
   (`daemon-projects.js:41`); the dropdown must not offer families the user
   cannot access — derive rows only from the projects payload the server
   already filtered.
5. **Deep links** (`/p/parent--dir`) keep working unchanged; entering via
   URL must produce the same title-bar state as arriving via the chip.

---

## Tests / verification

Client-heavy change, so automated coverage is the sweeps plus:

- `node scripts/check-client-imports.js` (new module import graph).
- If `familyOf`/label-resolution helpers are pure, put them in the new
  module as exported functions and add `test/worktree-switcher.test.js`
  exercising family derivation from a fixture projects array (parent with
  2 wt, orphan wt whose parent is absent, inaccessible wt).

Manual acceptance (record in this file's verification log):

1. Project with 2 worktrees: strip shows ONE icon; chip shows the default
   branch; dropdown lists 3 rows + New worktree.
2. Switching via chip keeps the project name/icon in the title bar and
   swaps sessions/file browser to the worktree; the strip highlight stays
   on the parent.
3. Processing dot on the parent icon lights when only a worktree session
   is running.
4. Create + remove a worktree from the chip; removal while inside it lands
   on the parent.
5. Cmd-K switcher rows read `parent ⎇ branch`; unreachable wt disabled.
6. DM/mate mode and home hub: chip hidden.
7. No `clay-wt-collapsed` reads/writes remain (`grep -rn "clay-wt-collapsed" lib/`).

---

## Verification log

- 2026-08-16: `npm test` passed (82/82), including four new pure helper tests.
- 2026-08-16: Both server/client syntax sweeps and
  `node scripts/check-client-imports.js` passed (82 client modules).
- 2026-08-16: Browser component harness with one parent and two worktrees
  passed: one active parent strip icon, parent title identity, branch label,
  aggregated processing/unread/pending state, three dropdown rows plus New
  worktree, inaccessible-row disabling, and DM/mate/home visibility gates.
- 2026-08-16: Keyboard switcher labels verified as `parent ⎇ branch`.
- 2026-08-16: Full authenticated create/remove and session/file-context swaps
  were not run because the local dev server required the user's Clay PIN; no
  live project registry was mutated during verification.
