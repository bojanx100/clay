# Live UI project picker debug report

## Symptom

The Chrome extension session list changed according to the project open in the
connected Clay control tab. A user could not reliably choose a chat from another
registered project, and selecting a session owned by a different project could
not pass the server's writable-root and development-server checks.

## Root cause

The Clay page published only `getCachedSessions()` for its current project. The
extension stored that identity per control tab and sent pairing back through the
same project's WebSocket. The behavior was therefore project-local by design,
not a stale popup cache.

That project-local pairing boundary is security-relevant: the receiving project
owns the writable root, development server, and target-origin validation. It
must not be bypassed by pairing a foreign session through the currently open
project.

## Fix

- Added an authenticated, access-filtered Live UI catalog to the existing global
  palette endpoint.
- The catalog includes registered base projects and only visible top-level
  regular or coordinator chats. Worker, hidden, worktree, Mate, and Lead sessions
  are excluded.
- The extension now asks for a project first and a chat second.
- When the selected project is not open in the chosen control tab, the extension
  navigates that tab to the project, waits for its authenticated page bridge to
  reconnect, and only then sends the existing project-local pairing request.
- The extension reinjects its content bridge after navigation, including on
  Tailscale/IP origins that are outside the manifest's automatic Clay URL list.
- Catalog and extension identity inputs are bounded to 100 projects and 500
  sessions, use text-only DOM rendering, and fail closed on access lookup errors.

## Verification

- Focused Clay catalog and client-contract tests cover access filtering, project
  filtering, worker exclusion, coordinator inclusion, and endpoint routing.
- Extension tests cover current-project pairing, cross-project navigation,
  post-navigation reinjection, reconnect-before-pair ordering, stale selections,
  empty projects, and credential-storage constraints.
- The full Clay and extension Node test suites pass.
- Changed modules pass the complexity ceiling, syntax checks, line-count limits,
  and whitespace validation.

## Runtime note

The live daemon was not restarted because other projects had active sessions.
The server change takes effect on the next normal Clay restart. The unpacked
Chrome extension must be reloaded once after pulling the extension commit.
