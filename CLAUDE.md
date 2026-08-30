# Project Rules

If a rule below can be checked mechanically, add the guard instead of trusting this file. The
`Co-Authored-By` rule was violated 91 times while written here in plain language; the `commit-msg`
hook that now enforces it has never been violated. Prose is the fallback, not the mechanism.

## Verifying your work

- **Prove a fix by breaking it.** A bug fix must ship with a test that fails when the fix is reverted — revert it, run the test, report the pass/fail counts both ways, then restore. A test that only passes with the fix in place has not been shown to test the fix.
- **Never verify a lookup by supplying the answer it is meant to find.** Hand-feeding the code under test the value it is supposed to discover proves the downstream path works and nothing else. Drive the real predicate against real data and observe the real result.
- **Check whether the work is already done before starting it.** Read the current status of the item, task, or file first. Re-running finished work burns a session and can create duplicate live records.
- **A green result is evidence for exactly what it exercised.** Say what a passing run did *not* cover, and never cite an artifact of a repair as evidence of the original cause.
- When debugging stalls, phantom reconnects, resume spam, or UI lag: read [docs/guides/DIAGNOSTICS.md](docs/guides/DIAGNOSTICS.md) and check the canary logs (`~/.clay/recovery-events-dev.log`, `~/.clay/diag-dev.log`) BEFORE reading source code. A fix is not done until the canaries are quiet.

## Live state and data safety

- **Never back up a `~/.clay` SQLite file by copying it.** The stores are WAL-mode and the main file is routinely hours or days stale, so a copy silently loses committed rows and then looks like a clean restore. Use `node scripts/snapshot-control-store.js`; `--audit` shows what plain copies have already cost. Details in [scripts/README.md](scripts/README.md).
- **Durable edits to live state under `~/.clay` require owner approval, a verified snapshot, and a stated rollback path.** Re-read the record afterwards and confirm the intended change, and only the intended change, actually landed.
- When rebuilding daemon config (e.g. `restartDaemonFromConfig()`), always use `Object.assign({}, lastConfig, overrides)` to preserve all existing settings. Never reconstruct config by manually listing fields.

## Git and working alongside other agents

- Always commit and push completed work. Commit and push only to the `bojan` branch; never commit or push to `master`/`main`. Create the `bojan` branch if it does not exist.
- Several agents work in this repo at once and all of them push to `bojan`, so treat the shared checkout as contended. Work in your own `git worktree` whenever another agent may be active: another agent's uncommitted files otherwise sit in your tree, where they silently join your test runs and your `git add`. `git fetch` and rebase onto the current `origin/bojan` immediately before every push — the tip moves underneath you. Never commit, revert, or stash a file you did not change yourself; foreign uncommitted work belongs to another agent, so leave it exactly as found and say so in your report.
- Use the `bojanx100` GitHub account for all commits and pushes in this repo (clay). `origin` is `bojanx100/clay`. Git auth is pinned to `bojanx100` through the repo-local origin URL and credential helper (`https://bojanx100@github.com/bojanx100/clay.git` with `gh auth git-credential`), so pushes work regardless of which `gh` account is globally active — no `gh auth switch` needed for git. (`gh` CLI commands like PR creation still use the active account, so switch with `gh auth switch --user bojanx100` for those.)
- Never create PRs, merge, or comment on issues automatically. Only do these when explicitly asked.
- Never add `Co-Authored-By` lines to git commit messages.
- Commit messages must follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:`, `build:`). Use `!` or `BREAKING CHANGE:` footer for breaking changes.
- Both commit-message rules above are enforced by a versioned `commit-msg` hook. Enable it once per clone with `git config core.hooksPath .githooks` (linked worktrees inherit the setting; a fresh clone needs the command again). `npm test` backstops the hook for any commit you have not pushed yet. Details in [scripts/README.md](scripts/README.md#commit-message-guard).

## Notes and documentation

- **Correct an earlier note in place.** When something in `memory/` or `docs/` turns out to be wrong, edit it where it stands and leave the wrong claim visible and marked as retracted, so the record explains its own history. Never add a second note that contradicts an existing one — a reader who finds two notes disagreeing cannot tell which to trust, and adjudicating them costs more than the original work.
- All user-facing messages, code comments, and commit messages must be in English only.

## Code style and structure

- Use `var` instead of `const`/`let`. No arrow functions.
- Server-side: CommonJS (`require`). Client-side: ES modules (`import`).
- Before adding new code, read [docs/guides/MODULE_MAP.md](docs/guides/MODULE_MAP.md) to find the right file. Never add inline logic to `project.js` handleMessage. Keep modules under 500 lines.
- Client modules (`lib/public/modules/`): state goes in store.js (zustand-like), WS via ws-ref.js, functions via direct import. Never use `var _ctx = null` / `initXxx(ctx)`. See [docs/guides/CLIENT_MODULE_DEPS.md](docs/guides/CLIENT_MODULE_DEPS.md).
- Never use browser-native `alert()`, `confirm()`, or `prompt()`. Always use custom JS dialogs/modals instead.
- Never use `localStorage` for user settings or preferences. All settings must be stored server-side (via WebSocket messages or REST API) so they persist across devices and browsers.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
