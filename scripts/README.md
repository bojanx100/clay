# Scripts

Maintenance utilities in this directory are intended to be run from the repo
root with `node scripts/<name>.js`.

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

## Other Utilities

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
