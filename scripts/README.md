# Scripts

Maintenance utilities in this directory are intended to be run from the repo
root with `node scripts/<name>.js`.

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
