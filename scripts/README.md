# Scripts

Maintenance utilities in this directory are intended to be run from the repo
root with `node scripts/<name>.js`.

## Parallel Preview Environment

Use a separate `CLAY_HOME`, `CLAY_CONFIG`, `CLAY_RC_PATH`, and port for a comparison
daemon. Stop only that destination before applying either sync. The source stays
online and is only read. A sync lock also rejects daemon startup while a copy is in
progress; a crash may leave the lock behind, so verify the PID recorded in it before
removing a stale lock.

```sh
node scripts/sync-preview-projects.js --source /path/to/original-state --target /path/to/preview-state
node scripts/sync-preview-projects.js --source /path/to/original-state --target /path/to/preview-state --apply
node scripts/sync-preview-sessions.js --source /path/to/original-state --target /path/to/preview-state --keep-session /path/to/preview-state/sessions/project/session.jsonl --apply
```

The project sync copies registered roots in order, their metadata and selected
conversation/provider preferences, mapping private projects to the preview owner.
It preserves listener/authentication settings, unknown destination settings and
Lead configuration. Without `--apply`, it only reports its plan.

The session sync stages a snapshot of saved sessions, hidden/archive choices,
Coop records, attachments, schedules and related conversation data. It does not copy
startup caches, historical `.bak` files, SQLite sidecars or symlinks. The active Coop
database is copied with the verified `snapshot-control-store.js` VACUUM path. The
source is live, so JSON files are individually captured and hash-verified; this is
not a transaction across every file and database. Non-session transcript fragments
are retained as evidence without inventing sessions for them.

The source admin ID is retained for historical ACL/reference integrity, while the
preview retains its own authentication material. Both tools require a single,
unambiguous admin mapping. `--keep-session` retains one extra preview conversation
only if its provider ID is absent from the copied inventory. Without `--apply`, the
session tool creates a verified staging copy but does not replace active state.

Old preview directories are moved to the printed rollback directory, including
extra sessions; they are not permanently deleted. Restore instructions and verified
config/user backups are stored there, alongside a consistent snapshot of the prior
Coop database. Stop the preview before any rollback.

The resulting preview uses `scheduledExecutionPaused: true`,
`restoreWorkOnStartup: false`, `nativeSessionDiscovery: false`, and
`manageClaudeSettings: false`. The last setting prevents preview startup from
redirecting the shared Claude notification hook or changing its permission allow-list.
The ordinary daemon retains native settings management by default. Schedules remain
defined and display **Paused**, copied queues/restart continuations/control recovery
do not start automatically, and native orphan discovery cannot refill the sidebar.
Explicit native imports remain available. These settings do not create a filesystem
or provider sandbox: the registered repository folders and native provider sessions
still belong to the same owner environment. Lead mode is preserved from the preview,
not activated by copying the original. A paused control startup barrier is intentional;
restoring live control authority is a separate cutover, not part of a history copy.

## Verified Runtime Activation

`verify-runtime-activation.js` compares the actual serving daemon with an explicit
checkout, commit and source fingerprint. It is read-only by default:

```sh
node scripts/verify-runtime-activation.js --socket /path/to/daemon-dev.sock --checkout /path/to/clay-worktree --revision FULL_COMMIT_SHA
```

After authorization, a verified state snapshot and a stated rollback path, add
`--restart` to request activation. The daemon refuses a restart that would load a
different checkout or source, rechecks after draining tools, and the script verifies
the process after restart. Exit success means `activationVerified: true`, not merely
that the restart request was accepted. An already active source needs no restart.
The default verification window is 30 seconds; a pending result does not claim
failure or cancel a longer graceful drain. Re-run without `--restart` to check it.

Daemons predating this identity endpoint need a coordinated initial upgrade;
the script will not blindly restart them. Existing restart commands remain available,
so project coordinators must use this verification workflow for activation claims.
See [Coop execution recovery](../docs/guides/COOP_INCIDENT_RECOVERY.md).

## Commit Message Guard

CLAUDE.md forbids `Co-Authored-By` lines and requires Conventional Commits.
Enable the guard once per clone:

```sh
git config core.hooksPath .githooks
```

That is the whole setup. It points git at the versioned `.githooks/` directory
instead of the unversioned `.git/hooks/`, so `.githooks/commit-msg` rejects a
bad message the moment you write it.

The setting lives in `.git/config`, which linked worktrees share, so running it
once in the main checkout also covers every `git worktree add` made from it --
which is how agents work in this repo. A **fresh clone still needs the one
command**; git will not run hooks out of the tree by itself, and there is no way
to make that automatic from inside the repository.

Because of that gap, the same rules also run as a test:
`test/commit-message-guard.test.js` is part of `npm test` and needs no setup at
all. It fails on any **unpushed** commit that breaks the rules -- the ones you
can still fix with `git commit --amend` or `git rebase -i`. It deliberately does
not scan pushed history: this repo's pushed commits already contain
`Co-Authored-By` trailers and non-conventional subjects, rewriting them is
forbidden, so scanning them could only make the suite permanently red.

### `check-commit-message.js`

The checker the hook runs. Also useful by hand:

```sh
node scripts/check-commit-message.js --history                  # check unpushed commits
node scripts/check-commit-message.js --message "feat: a thing"  # check one message
node scripts/check-commit-message.js .git/COMMIT_EDITMSG        # check a message file
```

Exit status is 0 when clean, 1 when a rule is broken. The rules themselves live
in `scripts/commit-message-rules.js`, which is pure and has no I/O, so the hook
and the test cannot drift apart.

Accepted subjects: `<type>[(scope)][!]: <description>` for `feat`, `fix`,
`docs`, `chore`, `refactor`, `perf`, `test`, `style`, `ci`, `build` and
`revert`. `revert` is accepted although CLAUDE.md's list omits it, because this
repo's history already uses it and semantic-release understands it. `Merge …`,
`Revert …`, `Reapply …`, `fixup!/squash!/amend! …` and `Release <version>`
subjects are exempt from the subject check -- git and release automation
generate them -- but the `Co-Authored-By` rule still applies to them.

To bypass the hook for a single commit: `git commit --no-verify`. The test
backstop still catches it before the commit is pushed.

## Shared `bojan` Branch Guard

The main `bojan` checkout is the source used by the local Clay daemon. Worktree
pushes used to advance `origin/bojan` without moving that checkout, so a restart
could still execute older code. Two versioned hooks and one push wrapper keep
the shared branch deterministic:

- `.githooks/pre-commit` rejects direct commits on `bojan`;
- `.githooks/pre-push` rejects direct updates to remote `bojan`;
- `node scripts/push-bojan.js`, run from a clean dedicated worktree, fetches and
  rebases onto the latest `origin/bojan`, pushes `HEAD:bojan`, and fast-forwards
  the clean main `bojan` checkout to the exact pushed commit, then attempts to
  remove the completed local worktree and branch.

Cleanup requires merged history, a clean unlocked linked worktree, no Git operation,
and no process with a working directory inside it (`lsof` must be available).
`main`, `master`, `bojan`, and branches containing `ui-overhaul` are protected.
If cleanup is pending, leave the worktree and run
`node scripts/cleanup-worktree.js <path>` from the primary checkout after its
session/processes exit. Ignored files are subject to normal Git worktree-removal
checks; the script never uses force. Remote feature branches are not deleted.
Stale work must be reconciled against its replacement before removal; age alone
never permits discarding unique commits or dirty files.

If the main checkout has uncommitted changes, the wrapper preserves them and
prints that synchronization was skipped. Resolve those changes, then rerun the
wrapper from a dedicated worktree or fast-forward `bojan` explicitly.

## Session Storage Safety

The session maintenance scripts read or edit the live Clay session store at:

```sh
~/.clay/sessions
```

Read-only listing scripts can run while Clay is open. Scripts that use
`--apply` edit or delete session files directly, so stop the Clay daemon before
running them with `--apply`. Otherwise the daemon can overwrite the edited meta
line or recreate state from memory.

The write-capable scripts are dry-run by default. Run them once without
`--apply`, inspect the output, then run again with `--apply` only when the
candidate list is correct.

## Session Cleanup Utilities

### `list-sessions.js`

Lists recent sessions across all projects with hidden status, modified time,
session id, project directory, and title.

```sh
node scripts/list-sessions.js
node scripts/list-sessions.js 50
```

Use this to find session ids for `keep-list.txt`.

### `list-bookmarks.js`

Lists bookmarked sessions and sessions that have a `favoriteOrder` value.

```sh
node scripts/list-bookmarks.js
```

### `keep-list.txt`

Contains session ids that cleanup scripts should preserve. Use one id per line.
Lines starting with `#` are ignored.

The cleanup scripts compare against the canonical session id: `meta.cliSessionId`
when present, otherwise the `.jsonl` filename without its suffix.

### `hide-old-sessions.js`

Hides every session not listed in `keep-list.txt` by setting `hidden: true` on
the session meta line.

```sh
node scripts/hide-old-sessions.js
node scripts/hide-old-sessions.js --apply
```

Stop the Clay daemon before using `--apply`.

### `clear-today-yesterday.js`

Deletes sessions in the same Today and Yesterday buckets used by the sidebar.
It keeps This Week and Older sessions, skips bookmarked sessions, and skips
sessions listed in `keep-list.txt`.

```sh
node scripts/clear-today-yesterday.js
node scripts/clear-today-yesterday.js --apply
```

Stop the Clay daemon before using `--apply`.

### `hide-handoff-sessions.js`

Finds auto-adopted handoff rollout sessions whose title or early content
contains Clay handoff markers, then hides them by setting `hidden: true` on the
session meta line.

```sh
node scripts/hide-handoff-sessions.js
node scripts/hide-handoff-sessions.js --apply
```

Stop the Clay daemon before using `--apply`.

## Control Store Safety

### `snapshot-control-store.js`

Takes a consistent, single-file snapshot of the Coop control store
(`~/.clay/lead/coop-control.sqlite`). **Run this before any control-plane
repair.** Do not hand-copy the `.sqlite` file: the store is WAL-mode, so a
main-file-only copy silently omits every committed row that has not been
checkpointed.

```sh
node scripts/snapshot-control-store.js --label pre-orphan-reconcile
node scripts/snapshot-control-store.js --audit
```

The source is opened read-only and is never modified, so this is safe to run
while the daemon is up. Snapshots land in `~/.clay/control-store-snapshots/`;
the script refuses to write beside the live store. Output reports how many rows
were captured and how many a main-file-only copy would have lost.

`--audit` lists the legacy hand-made `coop-control.sqlite.pre-*.bak` files with
how far behind the live store each one is. All of them are stale and none should
be used to restore; see [DIAGNOSTICS.md](../docs/guides/DIAGNOSTICS.md).

## Other Utilities

### `heal-closed-thread-states.js`

Repairs legacy Thread records whose conventional status says `closed` while
their primary `threadState` still keeps them in the live Threads rail. It is a
dry-run by default and reports every candidate and close classification.

```sh
node scripts/heal-closed-thread-states.js
node scripts/heal-closed-thread-states.js --apply --reconcile-requests --owner-approved
node scripts/heal-closed-thread-states.js --file /tmp/coop-topic-index.json --apply
```

Live application requires Clay to be stopped plus `--reconcile-requests` and
`--owner-approved`. The script writes and verifies a snapshot manifest first,
settles linked owner requests, then heals only that exact previewed candidate
set. A failure or crash may leave some idempotent request settlements committed,
but the topics remain repairable; rerun the same command immediately to
completion. The command prints the concrete rollback path before writing.

### `check-client-imports.js`

Checks that every relative ES module import under `lib/public/` resolves to an
existing file.

```sh
node scripts/check-client-imports.js
```

### `publish-alias.js`

Builds and publishes the `claude-relay` npm alias package for a supplied
version. This is a release utility and requires npm publishing credentials.

```sh
node scripts/publish-alias.js <version>
```
