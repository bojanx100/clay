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

## Follow-up: false dev-server-required error

The Webapp Vite server was listening on `::1:6075`, while Clay's development
port probe connected only to `127.0.0.1`. The session root and configured port
were correct, but the IPv4-only probe marked the IPv6-only localhost listener
offline, causing Live UI to return `LIVE_UI_DEV_SERVER_REQUIRED`.

Unmanaged dev-server discovery now checks both IPv4 and IPv6 loopback. A real
IPv6-only listener regression test fails with the previous implementation and
passes with the fix. The existing cwd ownership check still decides whether the
discovered listener belongs to the selected session. Arbitrary production
listeners on other ports are not adopted as HMR development servers.

## Follow-up: project-first loading and false Clay connection

### Symptom

The extension could remain on `Connected. Reading Clay sessions…` indefinitely.
Project discovery also waited for one server-wide catalog containing every
project's sessions, even though the interaction selects a project before it
needs any chats.

### Root cause

The extension treated successful `content.js` injection as proof that the
active tab was Clay. Local development apps also accept that content script, so
pressing `Connect this tab as Clay` on a localhost app created a port but never
produced the Clay page identity that the picker requires.

Separately, the Clay page delayed its identity until
`/api/palette/search?scope=live-ui` had scanned the sessions of every registered
project. The protocol had no selected-project session request.

### Fix

- Clay identity now publishes the access-filtered project list already cached
  by the sidebar immediately. It does not wait on session I/O.
- Selecting a project sends a dedicated extension request. The authenticated
  Clay page then fetches only
  `/api/palette/search?scope=live-ui&project=<slug>` and returns that project's
  chats.
- The scoped endpoint excludes hidden chats, workers using either orchestration
  parent shape, loop children, Coop channels, worktrees, Mates, and Coop home.
  It retains visible regular chats and coordinators in sidebar-compatible
  bookmark/recency order.
- Unloaded, loading, empty, and failed project states are explicit in the popup.
  The previous unbounded `Reading Clay sessions…` success message is gone.
- A tab is not considered connected until it returns a valid Clay identity.
  Normal localhost application tabs are rejected before injection, and the
  connect button is shown only while the active tab is a Clay project route.

### Fresh verification

- The running daemon returned the lightweight eight-project list in about
  17 ms without session fields.
- Scoped live requests returned 5 Clay chats, 4 Webapp chats, and 6 Urban Stay
  chats without scanning the other projects.
- Focused fail-first coverage verifies project discovery without session access,
  selected-project-only scanning, top-level filtering, unloaded project state,
  on-demand extension relay, and rejection of a normal localhost app as Clay.
- The Clay suite passed 1,016/1,016 tests and the extension suite passed 20/20.
- Focused complexity, syntax, line-count, and whitespace checks pass. Recent
  recovery/diagnostic canaries contain no Live UI or WebSocket regression.

The unpacked extension still needs one reload so its MV3 background worker uses
the new picker protocol; the popup file alone is not enough to refresh an
already-running background worker.

## Follow-up: automatic Clay discovery and sidebar-equivalent roots

### Symptom

The target-app popup still required a user to open the extension on a Clay tab
and click a one-time connect button. In Webapp, the chat picker also listed
`#2461 UI redesign (slice 4)` even though the sidebar nested that historical
worker under the `REDESIGN` coordinator and showed only three top-level rows.

### Root cause

The extension picker trusted only content-script ports that had already
returned a Clay identity. It never looked for an already-open `/p/<project>/`
tab when no verified control existed.

The Live UI endpoint filtered persisted `orchestrationParent` fields, while the
sidebar also derives historical worker ownership from coordinator task records
and `orchestrationAdoption`. The Slice 4 session has that legacy adoption shape,
so it appeared top-level only in the extension.

### Fix

- When the popup has no verified Clay control, the background scans open HTTP(S)
  `/p/<project>/` tabs, injects the existing content bridge, and asks for a Clay
  identity automatically. Injection is retried at a bounded interval.
- A matching URL is only a discovery candidate. Projects remain unavailable
  until the page returns the existing validated Clay identity, preserving the
  authenticated control boundary.
- The popup reports `Finding Clay` while discovery is active and no longer asks
  the user to perform the normal connection step. The manual action remains as
  a recovery fallback on an active Clay project route.
- The scoped Live UI endpoint now builds orchestration groups from the same
  visible, access-filtered session set used for the response and excludes both
  persisted and dynamically derived worker parents.

### Fresh verification

- Fail-first tests reproduced both defects: the historical Slice 4 session was
  returned as a root, and an open Clay project tab was never injected.
- The focused regressions now pass and verify that discovery injects the Clay
  candidate rather than the active web app, then exposes it only after identity
  validation.
- The full Clay suite passes 1,017/1,017 tests; the full extension suite passes
  21/21 tests.
- Syntax, whitespace, module-size, and focused complexity checks pass. The
  current diagnostic canary remains quiet; recovery entries are unrelated
  historical provider and cross-project events.

The Clay daemon was not restarted to avoid interrupting active project turns.
The endpoint correction takes effect on the next normal restart. Reload the
unpacked extension once so its MV3 background worker loads automatic discovery.
