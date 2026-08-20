# Project Rules

<!-- coop-authority-contract:start -->
## Coop staffing and spend authority disclosure

- **Scope:** Whenever Coop acts on, declines, or discusses a staffing/spend-class exchange, state Coop's effective Lead authority. This includes staffing or spend proposals, approvals, declines, staffing reports, and budget discussions. Do not add a Lead-mode or authority banner to routine technical answers, ordinary conversation, or status reports unrelated to staffing or spend.
- **Lead mode ON:** Say: "Lead mode is on: I can autonomously staff admitted, non-self-modification work within budget; self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval." Then apply the existing admission, self-modification, and budget gates.
- **Lead mode OFF:** Decline requested staffing or spend actions and say: "Lead mode is off: I cannot staff work or authorize spend. I can still find, triage, or switch to sessions." Coop remains a plain coordinator; it may find, triage, or switch, but it must not staff work or authorize spend.
- **Owner routing:** Sessions the owner opens directly remain direct owner sessions. Never adopt, reroute, or place them under Coop unless the owner explicitly hands them to Coop.
<!-- coop-authority-contract:end -->

- Never add `Co-Authored-By` lines to git commit messages.
- Use `var` instead of `const`/`let`. No arrow functions.
- Server-side: CommonJS (`require`). Client-side: ES modules (`import`).
- Always commit and push completed work. Commit and push only to the `bojan` branch; never commit or push to `master`/`main`. Create the `bojan` branch if it does not exist.
- Several agents work in this repo at once and all of them push to `bojan`, so treat the shared checkout as contended. Work in your own `git worktree` whenever another agent may be active: another agent's uncommitted files otherwise sit in your tree, where they silently join your test runs and your `git add`. `git fetch` and rebase onto the current `origin/bojan` immediately before every push — the tip moves underneath you. Never commit, revert, or stash a file you did not change yourself; foreign uncommitted work belongs to another agent, so leave it exactly as found and say so in your report.
- Use the `bojanx100` GitHub account for all commits and pushes in this repo (clay). `origin` is `bojanx100/clay`. Git auth is pinned to `bojanx100` through the repo-local origin URL and credential helper (`https://bojanx100@github.com/bojanx100/clay.git` with `gh auth git-credential`), so pushes work regardless of which `gh` account is globally active — no `gh auth switch` needed for git. (`gh` CLI commands like PR creation still use the active account, so switch with `gh auth switch --user bojanx100` for those.)
- Never create PRs, merge, or comment on issues automatically. Only do these when explicitly asked.
- All user-facing messages, code comments, and commit messages must be in English only.
- Commit messages must follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:`, `build:`). Use `!` or `BREAKING CHANGE:` footer for breaking changes.
- Both commit-message rules above are enforced by a versioned `commit-msg` hook. Enable it once per clone with `git config core.hooksPath .githooks` (linked worktrees inherit the setting; a fresh clone needs the command again). `npm test` backstops the hook for any commit you have not pushed yet. Details in [scripts/README.md](scripts/README.md#commit-message-guard).
- Never use browser-native `alert()`, `confirm()`, or `prompt()`. Always use custom JS dialogs/modals instead.
- When rebuilding daemon config (e.g. `restartDaemonFromConfig()`), always use `Object.assign({}, lastConfig, overrides)` to preserve all existing settings. Never reconstruct config by manually listing fields.
- Before adding new code, read [docs/guides/MODULE_MAP.md](docs/guides/MODULE_MAP.md) to find the right file. Never add inline logic to `project.js` handleMessage. Keep modules under 500 lines.
- Never use `localStorage` for user settings or preferences. All settings must be stored server-side (via WebSocket messages or REST API) so they persist across devices and browsers.
- Client modules (`lib/public/modules/`): state goes in store.js (zustand-like), WS via ws-ref.js, functions via direct import. Never use `var _ctx = null` / `initXxx(ctx)`. See [docs/guides/CLIENT_MODULE_DEPS.md](docs/guides/CLIENT_MODULE_DEPS.md).
- When debugging stalls, phantom reconnects, resume spam, or UI lag: read [docs/guides/DIAGNOSTICS.md](docs/guides/DIAGNOSTICS.md) and check the canary logs (`~/.clay/recovery-events-dev.log`, `~/.clay/diag-dev.log`) BEFORE reading source code. A fix is not done until the canaries are quiet.
