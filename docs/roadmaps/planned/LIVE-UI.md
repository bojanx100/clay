# Clay Live UI

> Select anything in a running web application, talk to the active Clay coding agent from the page, and watch the agent diagnose or redesign the interface by changing the real source code. The same interaction supports bug investigation and visual editing.

**Created**: 2026-07-18

**Status**: Implementation — first end-to-end vertical slice available on `bojan`

**Initial scope**: Development environments, with first-class validation against Clay, the TrialView webapp, and Urban Stay

---

## Implementation Progress

The first vertical slice now covers the core Clay-on-Clay interaction:

- server-authoritative pairing tied to the user, project, pinned session, extension instance, target tab, exact loopback origin, and writable root;
- reconnect credentials, target reload recovery, control reload rebinding, explicit revocation, and exactly-once target message acceptance;
- a Workspace **Open Live UI** action;
- a closed-shadow-root target toolbar with element hover, selection, persistent outline, reselection after reload, and exit;
- bounded, scrubbed selection context attached to the canonical Clay message path;
- compact target-page chat with assistant streaming, working state, errors, and Clay-only approval/input notices;
- pinned-session dispatch that does not retarget the control tab, plus a busy-session guard that prevents unrelated output from entering the overlay.

This completes the usable pairing/selection/chat slice of Phases 0–2 and the
selection-context portion of Phase 3. It does not yet complete the screenshot,
generic source-resolution, operation-journal, compile-generation, diff,
before/after, or verification-predicate work in Phases 1, 3, and 4. React
instrumentation and the TrialView/Urban Stay rollout remain 0.2 work.

The extension implementation lives in the separate `bojantv/clay-chrome`
repository on its `bojan` branch.

---

## Decision Summary

Build Live UI as a Clay-owned browser workflow, not as another bug-reporter implementation embedded separately in every application.

The first version has two layers:

1. A framework-neutral selection and chat layer that works on any normal DOM page. This is how Clay can edit its own vanilla JavaScript interface.
2. A React source-locator that adds higher-confidence component and file information for the TrialView Vite application and the Urban Stay Next.js application.

The user does not choose between a bug-reporting mode and a design mode before starting. Intent is inferred from the conversation:

- “This button does nothing” starts an investigation and repair loop.
- “Make this section less cramped” starts a visual editing loop.
- “Why does this flash before loading?” combines both.

Every accepted result is a source-code change intended for the active session's server-resolved project root. A worktree is preferred, but a main checkout is allowed when the repository instructions and current session permissions allow it. Live UI does not widen or replace the provider's real filesystem permissions. Temporary DOM or CSS changes are deferred until after the first release and are never considered a completed fix.

## Release Cut

The full roadmap covers three applications, but the first releasable slice is smaller:

### Live UI 0.1

- Clay-managed loopback development URLs only.
- Clay editing Clay, using separate control and target tabs.
- Generic DOM selection and repository source resolution.
- Target-page chat mirrored to one pinned Clay session.
- Source-backed edits attributed to the server-resolved project root.
- Full-reload verification and before/after evidence.
- No React instrumentation, remote previews, production overlay, touch support, temporary CSS previews, or automatic undo.

### Live UI 0.2

- TrialView and Urban Stay dogfood.
- React/Vite and React/Next source instrumentation prototypes.
- Operation-scoped guarded undo.
- Responsive verification presets.

### Later releases

- Approved remote preview URLs.
- Polished bug and design affordances.
- Optional temporary visual previews.
- Production bug-report handoff to a live developer session.

This release cut prevents React source instrumentation and remote deployment identity from blocking proof of the core interaction.

## Why This Is Worth Building

Traditional bug reporting separates the person who sees a problem from the developer who fixes it. The reporter captures evidence, submits a ticket, waits for triage, and later tries to explain the same interface again.

Live UI collapses that loop:

```text
See problem
  -> select the exact element
  -> describe the desired outcome
  -> agent inspects runtime evidence and source
  -> agent edits through existing session permissions
  -> dev server refreshes
  -> Clay verifies the result
  -> continue the same conversation
```

Framer 3.0 demonstrates the value of selection-scoped agent work: its agent reads the current canvas, edits the selected area, and uses branches to isolate changes before they are applied. Clay cannot copy Framer's internal canvas model because Clay operates on arbitrary application source code. It can copy the interaction contract: point, talk, inspect, edit, verify, and approve.

References:

- [Framer 3.0](https://www.framer.com/updates/framer-3)
- [How to use Framer Agents](https://www.framer.com/help/articles/how-to-use-agents/)
- [How to use branches in Framer](https://www.framer.com/help/articles/how-to-use-branches-in-framer/)
- [Use external agents with Framer](https://www.framer.com/help/articles/use-external-agents-with-framer/)

## Product Boundary

### In scope for the roadmap

- A user starts Live UI from an active Clay session.
- Clay opens or pairs the session with its running development tab.
- A lightweight toolbar and chat drawer appear inside the target page.
- Hovering outlines elements; clicking selects one element or a section.
- The selected element becomes persistent context for the conversation.
- Messages from the target page are sent to the active Clay coding session.
- Agent output streams back into both Clay and the target-page drawer.
- Clay collects sanitized runtime evidence around the selected element.
- The agent edits the active session's real source tree.
- Clay waits for refresh, resolves the selected element again, and captures an after state.
- The user sees a short result, the code diff, and before/after images.
- The same flow works for behavior bugs and visual changes.

### Explicitly out of scope for Live UI 0.1

- A full Framer-style freeform canvas.
- Drag handles that directly rewrite layout code.
- A complete CSS property inspector.
- Production-site editing.
- Running the Live UI overlay on production pages in version 0.1.
- Automatic publishing or deployment.
- Support for every frontend framework.
- Replacing the existing production bug reporters in TrialView or Urban Stay.
- Treating a temporary browser-side mutation as a completed change.

The existing bug reporters remain the right path when an end user needs to submit an asynchronous production report. Live UI 0.1 is a developer workflow attached to a real Clay coding session and a Clay-managed loopback development URL.

## First Three Targets

| Target | Frontend | Initial locator | Expected experience |
|---|---|---|---|
| Clay | Vanilla ES modules and server-rendered HTML | Generic DOM evidence plus repository search | Full selection, chat, edit, refresh, and verification; source location may begin as best-effort |
| TrialView webapp | React 19, Vite, MUI, Emotion, SCSS | Generic evidence plus React/Vite source locator | High-confidence component and source-file candidates |
| Urban Stay | React 19, Next.js 16, Tailwind | Generic evidence plus React/Next source locator | High-confidence component and source-file candidates |

This split is intentional. “React-only” would exclude Clay itself. The generic layer makes the product useful everywhere, while React support improves precision instead of defining basic compatibility.

## Core User Experience

### Starting Live UI

The Workspace panel gains an **Open Live UI** action beside the current development URL.

1. Clay verifies that the active session has an authorized writable root and a running development server.
2. Clay opens the development URL or lets the user choose an already-open matching tab.
3. The extension pairs that tab with the project and session selected at creation time.
4. The target page receives a small Live UI toolbar.

The pairing is pinned to the session selected at creation time. Switching sessions in the Clay control tab does not silently retarget an existing Live UI page. The user must explicitly re-pair it.

Pairing is ephemeral session state, not a user preference. The server is authoritative. The extension may keep the minimum pairing key in extension session storage so a Manifest V3 service-worker restart or target reload can reconnect, but it does not store user settings in `localStorage`.

### Selecting an interface element

The toolbar exposes a pointer action:

```text
[ Select ] [ Current selection: PricingCard ] [ Chat ] [ Exit ]
```

While selection is active:

- Hover draws a clear outline without changing layout.
- Clicking prevents the application's click only for that selection gesture.
- Escape cancels.
- The overlay itself is excluded from screenshots and selection.
- Nested elements can be promoted to a useful parent section.
- The selected element stays outlined until cleared or replaced.

The chat drawer shows a compact selection card:

```text
PricingCard
section · “Professional”
1280 x 832 · /pricing
Likely source: src/components/PricingCard.tsx
```

Low-confidence source matches are labeled as candidates, never presented as fact.

### Talking and editing

The target-page drawer is another view of the pinned Clay session, not a separate chat system. A message sent from it uses the existing Clay session pipeline and obeys the same provider, model, permissions, instructions, writable root, and repository rules.

The selection card is attached as structured context to each message until the user clears it. The agent can still ask follow-up questions. Tool approvals that cannot safely fit in the target overlay open in Clay, while the overlay shows “Approval required in Clay.”

### Refresh and verification

After an edit:

1. Clay observes the dev server refresh or page navigation.
2. The extension resolves the selection again using stable anchors.
3. Clay captures the after screenshot and relevant runtime state.
4. The agent runs repository-appropriate verification.
5. The overlay reports one of:
   - **Fixed and verified**
   - **Changed, needs your visual approval**
   - **Could not verify** with a specific reason

The user can keep chatting against the re-resolved element.

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│ Target application tab                                          │
│                                                                 │
│ Live UI overlay                                                  │
│  - element picker                                               │
│  - selection card                                               │
│  - compact streaming chat                                       │
│  - before/after presentation                                    │
└───────────────────────────────┬─────────────────────────────────┘
                                │ extension port
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ clay-chrome                                                     │
│  - tab pairing                                                  │
│  - sanitized DOM/runtime capture                                │
│  - overlay command relay                                        │
└───────────────────────────────┬─────────────────────────────────┘
                                │ existing Clay-page bridge
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Clay project server                                             │
│  - session/project/writable-root binding                        │
│  - selection lifecycle                                          │
│  - message context assembly                                     │
│  - stream relay to target tab                                   │
│  - verification orchestration                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ existing agent/session pipeline
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│ Coding agent                                                    │
│  inspect source -> edit files -> run checks -> browser verify   │
└─────────────────────────────────────────────────────────────────┘
```

Do not render the application inside an iframe in Clay for Live UI 0.1. Authentication, content security policy, frame restrictions, service workers, WebRTC, and application-specific browser behavior make an iframe a weaker representation of the real app. Pairing the actual browser tab preserves the application's real development environment.

### Process ownership

| Process | Trust and responsibility |
|---|---|
| Target content script | Render the closed-shadow-root overlay, capture sanitized DOM evidence, and send target-tab events. It never chooses a project, session, or filesystem root. |
| Extension service worker | Maintain target and Clay-page ports, hold the ephemeral reconnect key, and relay versioned envelopes. It cannot authorize an edit. |
| Clay control page | Request pairing for its authenticated user and active session, forward extension envelopes over its existing authenticated WebSocket, and render canonical Clay UI. |
| Clay server | Authorize and own pairings, derive project/session/root identity, deduplicate messages, attach selection context, and revoke invalid connections. |
| Coding agent | Inspect and edit only through the existing session permission and repository-instruction system. |

The target packet's `projectSlug`, `sessionId`, `tabId`, URL, and source candidates are claims. The server derives project, session, user, writable root, and allowed origin from the authenticated pairing. It rejects claims that disagree.

### Pairing state machine

The server owns one state record per pairing:

```jsonc
{
  "pairingId": "server-generated-id",
  "userId": "authenticated-user",
  "serverInstanceId": "clay-server-instance",
  "projectSlug": "derived-project",
  "sessionId": "pinned-session",
  "writableRoot": "server-resolved-root",
  "extensionInstanceId": "registered-extension",
  "controlClientId": "authenticated-clay-page",
  "controlReconnectTokenHash": "server-held-hash",
  "targetTabId": 123,
  "allowedOrigin": "http://localhost:4242",
  "state": "pairing",
  "createdAt": 1784390400000,
  "lastSeenAt": 1784390400000,
  "expiresAt": 1784419200000
}
```

States:

```text
unpaired
  -> pairing       control page requests a nonce for an allowed target
  -> paired        target proves possession of the nonce through the same extension instance
  -> reconnecting  a known target or control port reloads within the grace window
  -> paired        authenticated identities and origin still match
  -> revoked       explicit exit, timeout, origin change, session deletion, user disconnect,
                   server restart, extension mismatch, or failed identity check
```

Rules:

- A pairing is pinned to one user, server instance, project, session, writable root, extension instance, control client, and target tab.
- Live UI 0.1 allows one pairing per target tab. A new request requires explicit takeover and revokes the old pairing.
- A target navigation outside the exact allowed loopback origin revokes the pairing. A route change within that origin does not.
- The default idle expiry is eight hours. Closing the session, target tab, or Live UI revokes it immediately.
- A target or control reload has a 30-second reconnect grace window. At pairing, the server issues a random control reconnect credential whose hash stays in the pairing record and whose raw value stays only in extension session storage. A newly authenticated Clay WebSocket must come through the same extension instance and present that credential to replace `controlClientId`; another same-user Clay tab cannot adopt the pairing without it. The server rotates the credential after a successful rebind.
- A Clay server restart revokes 0.1 pairings. Durable restart recovery is not required for the first release.
- State is scoped per authenticated user and client, never stored as one project-global “current extension” socket.

### Connection registry

The existing `browserState._extensionWs` single-client slot is not sufficient for Live UI. Live UI adds a server-level registry keyed by authenticated user, server instance, extension instance, and Clay client. Existing browser automation can migrate later, but Live UI must not overwrite or depend on the last Clay page that reported a tab list.

### Message envelope and exactly-once behavior

Every Live UI relay uses a versioned envelope:

```jsonc
{
  "protocolVersion": 1,
  "pairingId": "server-generated-id",
  "operationId": "selection-conversation-operation",
  "clientMessageId": "target-generated-uuid",
  "streamSequence": 17,
  "event": "chat.user_message",
  "payload": {}
}
```

- The target generates one `clientMessageId` per submitted message and retries it until acknowledged.
- The server stores a bounded deduplication record per pairing and returns the original acknowledgement for retries.
- Only the server enqueues the canonical Clay user message.
- Assistant overlay events receive a monotonic `streamSequence` per operation.
- The target acknowledges the highest contiguous sequence and reconnects with that cursor.
- The server replays only the bounded current-operation overlay stream. Full history remains canonical in Clay and is not copied into the target overlay.
- Out-of-order events are buffered briefly; gaps cause a cursor replay request instead of duplicate rendering.
- Stop, steer, queued-message, question, refusal, completion, and error events carry the same operation identity.
- The canonical queue item created from a target message carries `operationId` through dispatch, provider query creation, tool lifecycle, questions, approvals, continuation, and completion. Session events without that causal identity, including messages started from Clay, schedules, or other pairings, never enter this target overlay stream.

### Pair and message sequence

```text
Clay control page -> Clay server: request pair(active session, candidate tab)
Clay server -> Clay control page: nonce + server-authoritative pairing candidate
Clay control page -> extension worker: pair target tab with nonce
Extension worker -> target content script: inject closed-shadow overlay
Target content script -> extension worker -> Clay control page -> Clay server: prove nonce
Clay server: validate user, extension, tab origin, session, and writable root
Clay server -> all hops: paired(pairingId, allowed capabilities)

Target overlay -> extension worker -> Clay control page -> Clay server:
  chat.user_message(clientMessageId, selectionGeneration, text)
Clay server: dedupe, attach current selection, enqueue exactly one session message
Clay server -> Clay control page -> extension worker -> target overlay:
  chat.stream(operationId, streamSequence, delta/status/question/completion)
```

### Reload and verification sequence

```text
Clay server: open operation journal for every target-originated turn before dispatch
Agent: inspect, edit, and run repository checks
Clay server: observe changed files and dev-server readiness
Clay server -> target: force final full reload
Target: reconnect using pairing key and new document generation
Target: report ready only after document complete and compile overlays are absent
Target: resolve the semantic selection fingerprint in the new generation
Target: capture sanitized after evidence
Clay server: evaluate verification predicates and close operation journal
Clay server -> target and Clay: machine-derived result state
```

### Clay editing Clay

Clay self-dogfooding requires two tabs:

- **Control tab**: owns the authenticated server bridge and active coding session.
- **Target tab**: renders the Clay interface being selected and refreshed.

Both tabs must identify the same Clay server instance. Refreshing or breaking the target must not destroy the control connection coordinating the edit. The extension binds the pairing to the explicit control client and server instance, so another Clay installation cannot adopt the target accidentally.

## Selection Packet

The extension sends a bounded, sanitized packet rather than raw page state:

```jsonc
{
  "version": 1,
  "documentGeneration": "target-load-id",
  "selectionGeneration": "selection-id",
  "timestamp": 1784390400000,
  "page": {
    "url": "http://localhost:3000/admin/reports",
    "route": "/admin/reports",
    "title": "Reports",
    "viewport": { "width": 1440, "height": 900, "dpr": 2 }
  },
  "element": {
    "tag": "button",
    "role": "button",
    "text": "Export report",
    "rect": { "x": 1120, "y": 94, "width": 148, "height": 40 },
    "anchors": {
      "testId": null,
      "id": null,
      "ariaLabel": "Export report",
      "cssPath": "main > header button:nth-of-type(2)"
    },
    "attributes": { "type": "button", "disabled": false },
    "computedStyles": {
      "display": "inline-flex",
      "position": "static",
      "color": "rgb(17, 24, 39)",
      "backgroundColor": "rgb(245, 158, 11)",
      "fontSize": "14px",
      "padding": "10px 16px"
    }
  },
  "source": {
    "framework": "react",
    "componentPath": ["ReportsPage", "ExportButton"],
    "candidates": [
      { "file": "src/components/ExportButton.tsx", "line": 42, "confidence": 0.94 }
    ]
  },
  "evidence": {
    "screenshotRef": "server-managed-reference",
    "consoleTail": [],
    "networkTail": []
  }
}
```

The selection packet is the envelope payload. It intentionally contains no authoritative user, server, project, session, writable-root, extension, or tab identity. The relay envelope supplies `pairingId`; the server resolves every other identity from its pairing record.

Limits:

- No form control values.
- No password, token, cookie, storage, authorization-header, request-body, or response-body values.
- Text and HTML fragments are length-limited and redacted.
- Only a curated computed-style subset is captured.
- Console and network records reuse the existing scrubbing approach from the browser tools and the two current bug reporters.
- Screenshots support ignore selectors and masked regions.
- Packets are associated with one project and session; they are not global browser context.

### Selection generations and restoration

Every page load receives a new `documentGeneration`. Every accepted click creates an immutable `selectionGeneration` containing a semantic fingerprint:

- Exact source marker when present.
- `data-testid`, id, role, accessible name, and stable attributes.
- Normalized text fragments.
- DOM ancestry landmarks.
- Initial route, bounding box, and relative position within the nearest landmark.
- React component candidates when available.

Restoration ranks candidates in this order:

1. Exact first-party source marker on the element.
2. Exact source marker on an ancestor plus matching semantic descendants.
3. Unique test id or id within the current route.
4. Unique role and accessible-name match within the same landmark.
5. Weighted ancestry, text, class, and geometric similarity.

The target returns a confidence score and the evidence used. A score below `0.80`, more than one near-equal candidate, a cross-origin navigation, or an unsupported surface moves the selection to **reselect required**. Clay never silently attaches the old conversation to a guessed replacement.

Portals are resolved in the same document using semantic anchors. Open shadow roots are inspected recursively; closed application shadow roots are unsupported. Cross-origin iframes and canvas pixels can be selected only as whole boundaries in the first release. Virtualized elements keep their semantic fingerprint after unmount but require reselect if the same item cannot be uniquely restored.

### Screenshot lifecycle

- The target content script computes viewport-relative mask rectangles from mandatory built-in masks plus the project's additive masking contract and returns them with the selected element rectangle.
- Built-in masks always cover password fields, value-bearing `input`/`textarea`/`select` controls, content-editable regions, browser-autofill surfaces detectable in the DOM, video/canvas/document viewers, cross-origin frames, and unsupported embedded surfaces. Project configuration may add masks but cannot remove these defaults.
- The extension service worker requests a tab-specific image through Clay's existing debugger-backed `tab_screenshot` path, raster-masks sensitive rectangles in extension memory, then derives the element crop from the masked viewport. If a browser cannot capture that paired tab in the background, the extension asks the user, activates the target with a visible capture notice, waits for stable layout, captures, and restores the previously active tab. It never silently captures a different active tab.
- Unmasked pixels are never uploaded, written to disk, or returned to Clay. Tests intercept the upload boundary and assert that only the masked raster crosses it.
- The Clay server validates packet shape, mask-policy version, dimensions, and references. It does not claim it can prove pixel redaction after the fact.
- Masked images use the existing authenticated project image upload/storage path and receive opaque references; the target never invents a filesystem name.
- Existing image-retention settings control expiry and cleanup.
- Capture failure is non-fatal, but the result cannot claim visual verification without an after image.
- Live UI 0.1 defines a small generic masking contract: ignore selectors, mask selectors, and “never capture text” selectors. Project bug reporters may export compatible values later without becoming runtime dependencies.

## Source Location Strategy

Source location is a confidence-ranked pipeline. No single technique works for all three targets.

### Level 1: Framework-neutral evidence

Available for every page:

- Stable selector candidates: `data-testid`, id, accessible name, role, text, and bounded CSS path.
- DOM ancestry and nearby text.
- Class names and curated computed styles.
- Route and viewport.
- Before screenshot and selected-element crop.
- Recent sanitized console and network entries.
- Repository search using visible text, ids, class names, and route names.

This is sufficient for many Clay edits because the agent can search the repository and verify candidates before modifying code.

### Level 2: React development metadata

For React development builds, collect component display names and ownership ancestry when safely available. React's public `captureOwnerStack` API is development-only and is not available from an arbitrary custom DOM event handler, so it cannot by itself map a clicked node back to source. It may supplement error capture, but Live UI must not depend on it for selection. See [React `captureOwnerStack`](https://react.dev/reference/react/captureOwnerStack).

A best-effort runtime adapter may inspect development metadata to produce component candidates. Any use of private React internals is isolated behind a versioned adapter and treated as advisory.

### Level 3: Development-only source instrumentation

Exact mapping comes from a build transform that injects a non-production source marker into host JSX elements:

```html
<button data-clay-source="src/components/ExportButton.tsx:42:5">
```

Requirements:

- Enabled only when the app is started with `CLAY_LIVE_UI=1` in development.
- Removed from production builds.
- Relative paths only; never expose the developer's absolute filesystem path.
- Preserve existing source maps.
- Do not instrument third-party packages.
- Provide a stable component chain where possible.
- Transform host JSX elements on both server and client compilation paths so hydration output is identical.
- Fall back to the closest instrumented first-party ancestor when a third-party component owns the final DOM.

The source transform lives in a versioned Clay development package rather than being copied into applications. Target repositories install a pinned development dependency and add one small build configuration entry. Removing the entry and dependency fully rolls the integration back.

TrialView uses the package's Vite plugin. Clay starts the dev command with `CLAY_LIVE_UI=1`, and the plugin returns an updated source map for each transformed first-party JSX/TSX module. Vite's official plugin API supports source transforms and source-map output: [Vite Plugin API](https://vite.dev/guide/api-plugin.html).

Urban Stay uses the package's Next.js 16 transform. The prototype must prove identical server/client attributes, no hydration warnings, source-map preservation, and zero markers in a production build. Next.js 16 supports Babel configuration under Turbopack and supports loader rules, but the implementation must be tested against the project's current Next version before it becomes required: [Next.js Turbopack](https://nextjs.org/docs/app/api-reference/turbopack).

If exact instrumentation is unavailable, Live UI falls back to Levels 1 and 2 instead of refusing to work.

The React prototype also instruments selected composite JSX callsites with a reserved development-only `data-clay-source` prop. Components such as MUI controls that forward `data-*` props can expose the first-party callsite on their final host node. Components that strip the prop remain best-effort and fall back to runtime ancestry or the nearest marked first-party ancestor. Locator metrics report host JSX, forwarding composite components, and non-forwarding composite components separately so a good aggregate score cannot hide a weak MUI or custom-component path.

The extension's isolated world cannot assume it can read React's main-world DOM expandos. Any React runtime prototype uses a narrow, static MAIN-world bridge that returns sanitized component names and source candidates through a random per-pairing channel. It never evaluates user-provided JavaScript. Private React metadata remains advisory and version-gated.

## Bug Investigation and Design Editing

Both intents use one transport and selection model, but their evidence and completion gates differ.

| Concern | Bug investigation | Design editing |
|---|---|---|
| Primary context | Behavior, console, network, route history, error stack | Screenshot, layout, computed styles, design tokens, responsive behavior |
| First agent action | Reproduce and identify the cause | Inspect existing design system and source ownership |
| Change requirement | Root-cause fix with relevant regression coverage | Source-backed visual change using project conventions |
| Verification | Reproduction no longer fails; relevant tests pass | Before/after review plus viewport checks |
| User approval | Required when behavior or product intent is ambiguous | Required for subjective visual judgment |

The system infers intent from language and agent behavior. A visible mode badge may appear after inference, but it is not an entry gate.

## Safety Model

### Environment boundary

Live UI 0.1 allows pairing only when:

- The target URL matches the active session's Clay-managed local development URL.
- The origin is loopback and the server confirms it owns the corresponding development process.
- For Clay self-editing, the control and target tabs identify the same Clay server instance.

Production and remote preview hosts are rejected entirely in 0.1. Revision-attested preview pairing requires a separate security design before a later release.

### Repository boundary

- The server resolves an intended project root for attribution and verification. A worktree is preferred; a main checkout is allowed only when the repository instructions and current session permissions allow it.
- Existing provider sandbox and permission settings remain the actual filesystem boundary. Live UI does not grant broader access.
- Any observed edit outside the intended root fails the Live UI safety predicate, prevents a successful/verified result, and disables automatic undo. Live UI 0.1 does not claim it can prevent a write that the underlying provider was already authorized to make.
- Live UI never invents a branch, commit, push, PR, or deployment policy. The coding agent follows the target repository's instruction files.
- A page selection never grants broader filesystem or command permissions.
- Tool approvals continue through Clay's existing permission system.
- Publishing and deployment remain separate explicit actions.

### Data boundary

- Selection packets are redacted before leaving the target tab.
- Input values and secrets are excluded by construction.
- Screenshot masking can be configured per project and begins with the masking rules already proven by the TrialView and Urban Stay bug reporters.
- The target overlay clearly shows when screenshot or diagnostic context is being attached.
- Captured evidence follows Clay's existing image-retention controls.

### Change boundary

- Live UI 0.1 does not offer direct browser mutation or temporary CSS preview.
- Completed work must survive a full reload.
- The result includes the real code diff.
- Undo is unavailable until operation-scoped patch attribution is implemented. It must never use a broad reset or silently alter unrelated user changes.

### Operation journal and guarded undo

Every target-originated turn receives an `operationId` and opens a journal before canonical message dispatch. Before the agent can edit, Clay records:

- Repository root, branch, and `HEAD`.
- The complete pre-existing dirty-file list and hashes.
- A baseline diff fingerprint.
- The current selection and document generations.

Provider adapters attach `operationId` to file-write tool events and report path, pre-image hash, post-image hash, and patch. A filesystem watcher reconciles those events with observed results. Shell-based, formatter, user, dev-process, or other-agent writes without matching provider attribution are marked **unattributed**. Clay records each touched file's first pre-image hash, final post-image hash, and attributed operation patch while preserving the pre-existing dirty diff.

Journal terminal states are:

- **no-change**: the turn completed or answered a question without a file mutation.
- **completed**: attributed changes and verification evidence were recorded.
- **interrupted**: the user or provider stopped the turn.
- **failed**: the agent, build, permission, or verification path failed.
- **superseded**: a newer operation intentionally replaced the result before verification.

Questions and approvals keep the journal open. A terminal session event closes it. A new target operation may queue behind an open operation, but it cannot silently share that operation's attribution window.

Guarded undo is a 0.2 feature. It is disabled for any operation containing concurrent or unattributed writes. Otherwise it is allowed only when every affected file still matches the operation's recorded post-image and the inverse patch applies without overlap. If another edit touched a file afterward, Live UI refuses automatic undo and offers an agent-assisted/manual resolution. Existing provider rewind is not treated as operation-safe undo.

### Verification manifest

Agent prose is not verification evidence. Tools and adapters emit assertion events into an operation manifest:

```jsonc
{
  "operationId": "operation-id",
  "assertions": [
    {
      "assertionId": "check-1",
      "type": "command.exit_zero",
      "producer": "exec",
      "commandLabel": "targeted unit test",
      "startedAt": 1784390400000,
      "finishedAt": 1784390404200,
      "exitCode": 0,
      "evidenceRef": "bounded-tool-result"
    },
    {
      "assertionId": "runtime-1",
      "type": "browser.selector_state",
      "producer": "clay-browser",
      "purpose": "reproduction",
      "reproductionId": "export-button-enabled",
      "phase": "after",
      "documentGeneration": "post-reload-generation",
      "selectorFingerprint": "selected-element-fingerprint",
      "predicate": "enabled-and-clickable",
      "passed": true,
      "evidenceRef": "browser-observation"
    }
  ]
}
```

Allowed initial assertion types are `command.exit_zero`, `dev.compile_success`, `browser.page_ready`, `browser.selector_state`, `browser.console_absent`, `browser.network_status`, and `user.visual_approval`. Each event names its tool/adapter producer and evidence reference. A repository may declare recommended checks in project instructions later; absent that configuration, the agent selects targeted commands through normal reasoning, but the result remains **Changed, needs review** unless the manifest contains the predicates required for the stronger state.

A bug reproduction assertion also carries `purpose: "reproduction"`, a stable `reproductionId`, and `phase: "before" | "after"`. **Fixed and verified** requires a tool-produced pre-edit assertion that observed the failure and a post-reload assertion that observed the pass for the same reproduction id, semantic target, and predicate. If the original bug cannot be reproduced before editing, the result cannot use that label even when tests pass.

### Dev-server build generations

Port liveness and missing browser overlays do not prove a healthy build. Live UI introduces dev-server adapters that emit compile generations correlated with file mutations:

- **Clay static adapter**: records server reachability, forces cache-busted reloads, runs syntax/repository checks for changed assets, and observes post-reload console failures.
- **Vite adapter**: observes compile/HMR start, success, and failure signals for TrialView.
- **Next adapter**: observes Next/Turbopack compile start, success, and failure signals for Urban Stay.

Final verification requires a successful generation whose completion occurred after the operation's last attributed file mutation and no later failure. If a framework adapter cannot establish that ordering, the result is **Could not verify** even when the page appears usable.

### Formal result states

The server derives result states from recorded predicates:

| State | Required evidence |
|---|---|
| **Edited, verification pending** | Attributed source files changed with no observed out-of-root write |
| **Build failed** | Dev server or repository check reports a compile/test failure |
| **Changed, needs review** | Full reload succeeded and after evidence exists, but behavior or visual intent still needs human judgment |
| **Fixed and verified** | No out-of-root or unattributed safety failure; a post-mutation compile generation succeeded; full reload and page-ready assertions passed; target origin and route are valid; selection restored at confidence `>= 0.80` or the user reselected it; required repository command assertions passed; matching tool-produced before-failure and after-pass reproduction assertions exist; masked after evidence was captured |
| **Could not verify** | One or more required predicates is absent, with each missing predicate listed |

Design work ends as **Changed, needs review** until the user visually approves it. Screenshot similarity alone never proves a bug fix. HMR may provide fast intermediate feedback, but final verification always forces a full page reload and a new document generation.

### Failure and recovery matrix

| Failure | Target-page behavior | Recovery |
|---|---|---|
| Session busy | Keep the message acknowledged but show queued/steered status from the canonical session | Existing Clay queue semantics decide when it runs |
| Session stopped, deleted, or unauthorized | Disable send and revoke pairing | Return to Clay and pair another eligible session |
| Agent asks a question | Render the bounded question state in the overlay when supported | Answer there or open the canonical Clay card |
| User presses stop | Send an operation-scoped stop request | Show interrupted only after server acknowledgement |
| Dev server crashes | Preserve selection fingerprint and show build failure | Restart through Workspace controls, then re-run verification |
| Extension or target disconnects | Enter reconnecting for up to 30 seconds | Replay from the acknowledged stream cursor or revoke |
| Control page disconnects | Target becomes read-only during grace period | Reconnect the same authenticated control client or revoke |
| Authentication redirect or origin change | Revoke immediately | Return to the allowed development origin and pair again |
| Selection cannot be restored | Show reselect required | User selects the replacement before more scoped edits |
| Unsupported approval | Pause the operation and link to Clay | Resolve in Clay, then stream the result back |

## Alternatives Considered

### A. Extension-first Live UI, recommended

The extension owns selection and the target-page overlay. Clay owns sessions, source changes, permissions, and verification.

**Pros**

- Works on Clay without migrating Clay to React.
- Uses the real authenticated application tab.
- One implementation serves all projects.
- Reuses Clay's browser bridge, dev-server control, session chat, agents, worktrees, and diffs.
- Keeps production bug reporters independent.

**Cons**

- Requires coordinated changes in the `clay` and `clay-chrome` repositories.
- Exact source mapping needs optional app build instrumentation.
- Overlay chat must mirror a subset of Clay session states safely.

### B. Application SDK embedded in each React app

Add a Live UI React provider to TrialView and Urban Stay, similar to their current bug-reporter providers.

**Pros**

- Direct access to application-specific state and masking rules.
- Easy React context integration.
- Could eventually serve trusted production users.

**Cons**

- Does not support Clay's current non-React interface.
- Duplicates transport, auth, rollout, and UI work across applications.
- Makes every application responsible for a Clay product surface.
- Increases application bundle and maintenance cost.

This remains useful only as an optional diagnostics adapter, not as the product foundation.

### C. Embed the application as a canvas inside Clay

Render the development site in an iframe beside Clay chat.

**Pros**

- Visually closest to Framer.
- Chat and preview share one window.

**Cons**

- Breaks or changes authentication, frame policies, service workers, WebRTC, browser permissions, and cross-origin behavior.
- Does not faithfully reproduce the user's actual application tab.
- Requires complex proxying for remote Clay installations.

Defer this. The target-page overlay delivers the useful interaction without pretending an iframe is the real app.

## Implementation Roadmap

**Implementation status (2026-07-26): started.** Clay now has the server-scoped
Phase 0 registry, session/dev-origin authorization, versioned pairing relay,
bounded and scrubbed selection packets, exactly-once acknowledgments, target
reload reconnect, control rebind, and revocation tests. The `clay-chrome`
target overlay and picker remain the next cross-repository slice, so Phase 0 is
not yet complete.

### Phase 0: Protocol and threat model

**Goal**: Lock the cross-repository contract before UI work.

- Define versioned Live UI messages between target tab, extension, Clay page, and server.
- Implement the server-level extension connection registry and authoritative pairing state machine.
- Define server-derived project, session, writable-root, tab, and selection identities.
- Define acknowledgement, deduplication, stream sequencing, and cursor replay.
- Carry `operationId` through canonical session queue and provider lifecycle events so unrelated turns cannot enter the overlay.
- Define the control reconnect credential and rotation flow.
- Define packet size and redaction limits.
- Restrict 0.1 to Clay-managed loopback development origins.
- Define reconnect and page-reload behavior.
- Add protocol tests on both Clay and extension sides.

**Exit gate**: A fake target tab can pair, send a sanitized selection packet, reload, reconnect, and unpair without leaking state to another project or session.

### Phase 1: Generic element picker

**Goal**: Select and retain an element in any target application.

- Add extension commands to start, stop, and update Live UI.
- Inject the selection overlay into the paired tab.
- Produce stable selector candidates and curated element metadata.
- Capture an element crop and viewport screenshot with overlay exclusion.
- Re-resolve a selection after navigation or refresh.
- Support mouse, trackpad, and keyboard cancellation. Touch is deferred until a supported extension-capable mobile browser is chosen.

**Exit gate**: A Clay target tab can select an element, produce a bounded packet, and either restore the outline above the confidence threshold after a full reload or explicitly request reselection.

### Phase 2: Session pairing and target-page chat

**Goal**: Talk to the active Clay agent without leaving the application.

- Add **Open Live UI** to the Workspace panel.
- Pair only with the active project's Clay-managed loopback development URL.
- Add a compact chat drawer in the target overlay.
- Route messages through the existing Clay session message path.
- Stream assistant text, processing state, questions, completion, and errors back to the overlay.
- Represent unsupported approvals with a link back to Clay.
- Keep the full transcript canonical in Clay.

**Exit gate**: A message typed in the Clay target appears in the pinned Clay control session exactly once, and its response streams back to both views. TrialView and Urban Stay repeat the same contract in 0.2.

### Phase 3: Agent context and generic source resolution

**Goal**: Make the selection useful to the coding agent without React-specific support.

- Attach the current selection packet to outgoing user turns.
- Add a server-side resolver that ranks repository files using route, text, ids, classes, and existing imports.
- Give the agent candidates with confidence and evidence, not forced conclusions.
- Teach the agent to verify the source owner before editing when confidence is low.
- Reuse existing browser tools for DOM, styles, console, network, screenshots, clicks, and verification.

**Exit gate**: On Clay, the agent can select a known control, find its owning module, make a source change, and survive reload without React metadata.

### Phase 4: Edit, refresh, and verify loop

**Goal**: Complete one real source-backed iteration.

- Resolve the authorized writable root and dev-server state from the active session and `project-workspace.js`.
- Open and close an operation journal around each source-changing turn.
- Observe refresh/navigation and provide status to the overlay.
- Add the Clay static dev adapter and compile-generation event contract.
- Re-resolve the selection after the DOM changes.
- Capture before/after evidence.
- Run repository-appropriate targeted checks.
- Derive the formal verification status from recorded predicates and surface the real diff.
- Force a full reload for the final gate; HMR is intermediate feedback only.

**Exit gate**: A user can request one Clay bug fix and one Clay visual change, reload fully, and see that the result persists. The system never emits **Fixed and verified** unless every required predicate is recorded.

### Phase 5: React source locator

**Goal**: Raise source-location precision for TrialView and Urban Stay.

- Add best-effort React component ancestry capture in development.
- Build a Vite development transform for TrialView.
- Build and validate a Next.js 16 development transform for Urban Stay.
- Inject relative source markers only in Clay Live UI development mode.
- Measure locator precision and fallback frequency.
- Keep private React runtime inspection isolated and optional.
- Add guarded operation undo after patch attribution tests pass.

**Exit gate**: Prototypes prove no production markers or hydration mismatches. At least 90% of selected first-party elements in the two React applications identify the correct source file in the top three candidates, and at least 75% identify it first. These metrics are prototype gates, not assumptions.

### Phase 6: Three-project dogfood release

**Goal**: Use Live UI for real work before generalizing it.

- Clay: repair and visually update Clay's own interface through Live UI.
- TrialView: test MUI/Emotion, SCSS, portals, virtualized lists, and document-viewer boundaries.
- Urban Stay: test Next navigation, Server Components, Tailwind, localization, protected pages, and mobile layouts.
- Record failed selections, wrong source candidates, lost pairings, stale screenshots, and unverified edits.
- Fix the shared mechanism before adding framework support.

**Exit gate**: Ten completed Live UI changes per project, with no cross-session edit, secret capture, unrelated-file undo, or false “verified” result.

### Phase 7: Polished bug and design workflows

**Goal**: Make both intents feel purpose-built without splitting the product.

- Bug work: reproduction notes, console/network timeline, error linkage, and regression-test prompt.
- Design work: design-token context, viewport presets, before/after slider, and responsive verification.
- Add temporary CSS preview only as a clearly labeled draft that must be converted to source.
- Add selection history within the current conversation.
- Add “Open live session” handoff from existing bug reports for developers.

**Exit gate**: Users can move between investigation and design feedback in one conversation without restarting or choosing a different tool.

## Expected Clay Modules

Final module placement must follow `docs/guides/MODULE_MAP.md` and keep every module under 500 lines.

### Server

| Proposed module | Responsibility |
|---|---|
| `lib/server-live-ui-registry.js` | Authenticated extension/control-client connection registry and server-instance identity |
| `lib/project-live-ui.js` | Pairing lifecycle, session/project authorization, selection state, overlay relay |
| `lib/project-live-ui-context.js` | Selection packet validation, redaction enforcement, agent-facing context formatting |
| `lib/project-live-ui-operations.js` | Operation journal, file attribution, guarded undo contract |
| `lib/project-live-ui-verification.js` | Full-reload generation, after capture, predicate recording, result-state derivation |
| `lib/ws-schema.js` | Versioned Live UI client/server message definitions |
| `lib/project-message-router.js` | Delegate Live UI messages to the dedicated module only |
| `lib/project-workspace.js` | Expose the active dev URL and writable-root binding needed to authorize pairing |
| `lib/browser-mcp-server.js` | Reuse existing inspection tools; add only genuinely missing browser operations |

### Client

| Proposed module | Responsibility |
|---|---|
| `lib/public/modules/live-ui.js` | Workspace entry point, pairing state, open/close actions |
| `lib/public/modules/live-ui-messages.js` | Route Live UI WebSocket state and extension relay messages |
| `lib/public/modules/live-ui-selection.js` | Render the current selection and before/after result inside Clay |
| `lib/public/css/live-ui.css` | Clay-side Live UI controls, following `DESIGN.md` tokens |
| `lib/public/modules/store.js` | Shared reactive state only; no module-owned context bag |
| `lib/public/modules/ws-ref.js` | Existing WebSocket reference, imported directly |

### Extension repository

The `clay-chrome` repository owns:

- Target-tab content overlay.
- Element picker and outline.
- Target-page compact chat rendering inside a closed shadow root. This prevents ordinary style and DOM collisions but is not a confidentiality boundary against a hostile page. Live UI 0.1 trusts its Clay-managed development target and mirrors only minimal current-operation text; the canonical Clay conversation and tool details never enter the target page.
- Selection extraction and client-side redaction.
- Target-tab pairing and reconnect.
- New versioned relay message handlers.

Clay must remain compatible with one previous extension protocol version during rollout and show an actionable extension-upgrade message when Live UI requires a newer version.

## Existing Work to Reuse

### Clay

- `lib/project-browser-extension.js`: extension command dispatch and request correlation.
- `lib/browser-mcp-server.js`: tab, screenshot, console, network, DOM, styles, evaluation, and interaction tools.
- `lib/project-workspace.js`: dev-server lifecycle, port, branch, preview, and worktree binding.
- `lib/public/modules/workspace-panel.js`: user entry point for the active development environment.
- Existing session messages, streaming, permissions, questions, diffs, rewind, and tool result rendering.

### TrialView and Urban Stay

Both applications already have substantial bug-reporter infrastructure for:

- Screenshot and area capture.
- Console, network, route, device, and performance buffers.
- URL scrubbing and sensitive-data masking.
- Error capture and fingerprinting.
- Production report submission and tests.

Reuse the proven redaction rules and diagnostic concepts. Do not move their product-specific production submission logic into Clay, and do not make Live UI depend on their providers being mounted.

## Testing Strategy

### Protocol and isolation

- Wrong project cannot pair with a tab.
- Wrong session cannot receive a selection or chat stream.
- A client-supplied project, session, root, origin, or tab claim cannot override the server pairing.
- Two Clay installations cannot adopt each other's target tab.
- A control-page reload can rebind only with the rotating reconnect credential held by the paired extension.
- Reload reconnects once without duplicate messages.
- Retried `clientMessageId` values enqueue exactly one canonical session message.
- Stream cursor replay fills a gap without duplicating already acknowledged deltas.
- Closing a session or target tab clears the pairing.
- Extension version mismatch fails with an actionable message.

### Security and privacy

- Passwords, input values, cookies, tokens, headers, storage values, and request bodies never appear in packets.
- Screenshots mask configured sensitive regions.
- Unmasked screenshot pixels never cross the extension upload boundary or persist to disk.
- Oversized DOM text, console, and network data are truncated.
- A production URL cannot enter editable mode.
- A selected element cannot expand filesystem permissions.

### Selection

- Nested DOM, portals, SVG, canvas boundaries, shadow DOM, fixed overlays, and scrolling.
- Element replacement after refresh.
- Responsive layouts at 375, 768, and desktop widths.
- Multiple target tabs and multiple Clay sessions.
- Reselect-required behavior for ambiguous or missing replacements.

### Agent loop

- Selection context reaches the correct agent turn.
- Unrelated Clay, scheduled, queued, or other-pairing turns never stream into the target overlay.
- Low-confidence location triggers inspection rather than a blind edit.
- An observed out-of-root change fails the operation safety predicate and cannot be reported as successful.
- Before and after evidence correspond to the same semantic element.
- Verification failure cannot be reported as success.
- Verification state is derived only from typed assertion events and a post-mutation compile generation, not agent prose.
- Unattributed or concurrent writes disable guarded undo.
- In 0.2, guarded undo refuses when a post-image hash changed and leaves unrelated dirty files unchanged.
- Clay self-editing reloads the target tab without disconnecting the control tab.

### Per-project dogfood cases

**Clay**

- Select a workspace-panel control and change its copy or spacing.
- Select a chat control with a behavior bug and repair it.
- Confirm vanilla-module source resolution works without React metadata.

**TrialView**

- Select an MUI button rendered through Emotion.
- Select a portal-based dialog.
- Select a virtualized row and retain enough context after it unmounts.
- Confirm i18n and repository-specific verification rules remain enforced.

**Urban Stay**

- Select a Server Component boundary and locate the first editable client or source owner.
- Select a Tailwind-styled control and update tokens without arbitrary colors.
- Verify protected pages do not expose session or customer data.
- Verify a design change at 375px and desktop width.

## Success Metrics

Dogfood metrics matter more than prompt demos:

- Time from selection to first useful agent action: under 10 seconds.
- Selection survives ordinary refresh: at least 95%.
- Correct source file appears in top three candidates:
  - React targets: at least 90%.
  - Clay generic target: at least 70% initially, improving through observed failures.
- No duplicate user messages after reconnect.
- No secret or input-value capture in automated security tests.
- No completed result marked verified without reload persistence and evidence.
- Median approval-free bug or visual iteration completes without leaving the target tab.

## Open Questions

1. Should subjective design edits apply source changes immediately, or offer an optional temporary CSS preview first? Recommendation: source-first for 0.1, preview mode in Phase 7.
2. Which tool states must render inside the target-page drawer versus linking back to Clay? Recommendation: stream text, questions, progress, and completion; keep filesystem and command approvals in Clay initially.
3. Should a production bug report offer “Continue live with a developer” when a developer is online? Recommendation: defer until the development workflow is reliable and the authorization model is separately designed.
4. How should Next.js Server Component ownership appear when the clicked DOM comes from a server-rendered component? Recommendation: show the server source candidate plus the nearest interactive client boundary, with confidence labels.

## Recommended Build Order

Build the generic Clay-on-Clay loop before the React source instrumentation.

That sequence proves the product: selection, conversation, source editing, refresh, and verification. React instrumentation then improves location accuracy for TrialView and Urban Stay without becoming a prerequisite for the workflow.

The first real milestone is deliberately small:

> Start Clay in development with separate control and target tabs, open Live UI against the target Clay interface, select one workspace control, ask the pinned control-session agent to change it, reload the target, and verify the source-backed result from the same target-page conversation.

If that feels fast and trustworthy, expand to the two React applications. If it does not, a more elaborate canvas will not save it.
