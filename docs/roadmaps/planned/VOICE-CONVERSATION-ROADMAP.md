# Clay Conversation Roadmap

> Make Clay usable as an ongoing conversation: think together, agree on an explicit plan, supervise execution, make corrections, verify completion, and move between projects and sessions with minimal keyboard or mouse use.

**Created**: 2026-07-18
**Last expanded**: 2026-07-18
**Status**: Planning
**Working coordinator name**: Coop

---

## Product Decision

The product is a **Conversation Engine**, not a speech-to-text feature and not an Android rewrite.

Voice is one transport into the same durable conversation lifecycle used by text. Clay must understand whether the user is exploring an idea, diagnosing an issue, approving a plan, supervising implementation, asking for status, correcting intent, or deciding that work is complete. Audio alone does not provide that understanding.

Build the shared conversation kernel and protocol first. Prove real-time conversation in the web app. Then add:

1. A phone-as-remote-audio mode for using a mobile microphone, speaker, headset, and Bluetooth devices while the full Clay UI remains open elsewhere.
2. Coop, a workspace-level voice coordinator for finding, triaging, and switching between projects and sessions.
3. A deliberately small native Android companion for the hardware and lifecycle capabilities browsers cannot provide reliably.

Do not rebuild ordinary Clay screens in Android. The daemon remains authoritative, the web app remains the full visual interface, and every client uses the same conversation state and control protocol.

---

## North-Star Experience

### Starting from an idea

1. The user describes an unfinished idea naturally.
2. Clay adds useful possibilities, challenges weak assumptions, and asks only the questions that materially change the outcome.
3. Clay and the user settle on a concrete plan with acceptance criteria and known caveats.
4. The user explicitly approves that exact plan version.
5. Clay executes it without mixing status questions or side conversation into the executor's instruction stream.
6. The user can ask what is happening at any time and receive a short, plain-language status from a read-only snapshot.
7. Corrections become explicit changes to intent. Clay explains what work is affected and updates only what needs to change.
8. Clay implements, tests, verifies, reports caveats, performs the appropriate repository or runtime steps, and asks the user to confirm whether the outcome is done.

### Starting from an issue

1. The user reports a symptom.
2. Clay investigates before prescribing a fix.
3. Clay explains the likely root cause, evidence, uncertainty, and confidence in plain language.
4. Clay proposes a repair and verification plan.
5. The user can ask for a deeper explanation, revise the plan, and explicitly approve it.
6. The conversation then follows the same execution, status, correction, verification, and closeout lifecycle as idea-driven work.

### Working across several sessions

1. The user says, “Coop, what needs me?”
2. Coop summarizes only blocked work, pending decisions, important failures, and meaningful completions.
3. The user says, “Get me the one working on X.”
4. Coop resolves the project and session, states which target it found, and asks when the target is ambiguous.
5. The user can talk to that session, ask for status, approve a decision, or say, “Coop, switch to Y.”
6. The user can say, “Go to project A and do Z.” Coop routes the intent to the correct target, where normal exploration or diagnosis and explicit plan approval still apply.

The experience should feel like working with capable teammates through a reliable coordinator, not dictating commands into a text box.

---

## Decisions Already Made

These are current product decisions, not open questions:

1. **Conversation mode is first-class.** Composer dictation remains a fallback, not the product model.
2. **Conversation and execution are separate lanes.** The conversational controller may inspect executor state, but status questions and discussion do not steer active work unless the user explicitly sends a revised intent.
3. **Every implementation requires explicit plan approval.** Approval names a specific plan version. A model may recommend approval but cannot grant it.
4. **Stop, pause, continue, status, target selection, and approval are deterministic controls.** They do not depend on a model guessing the user's intent correctly after the command is resolved.
5. **Plans are versioned intent records.** Corrections create an intent diff and identify the work and acceptance criteria they invalidate.
6. **The daemon is authoritative.** Conversation state survives browser reloads, daemon restarts, compaction, provider handoffs, and switching devices.
7. **Voice and text share one transcript and lifecycle.** Audio is ephemeral by default. Durable records contain transcripts, decisions, plan versions, summaries, and outcomes.
8. **Secrets are never spoken.** Clay redacts sensitive values from speech, transcripts intended for narration, diagnostics, and summaries.
9. **One audible speaker and one active microphone route are the default.** This prevents overlapping agents and feedback loops.
10. **Coop and multi-Mate rooms are separate concepts.** Coop coordinates workspace activity; a room moderates participants inside one task.
11. **Android is a hardware companion, not a second Clay application.** Native work begins only where it materially improves audio routing, background operation, lock-screen controls, or reliability.

---

## Existing Foundation and Gaps

Clay already has an installable PWA, mobile layouts, a service worker, push notifications, WebSocket streaming and reconnect handling, browser dictation, persistent sessions, provider-neutral execution through YOKE, plan and permission interactions, deterministic session controls, cross-project session search, Mates, and structured debates.

Those are useful building blocks, but none is the Conversation Engine by itself. Today, browser speech recognition primarily fills the composer; project WebSockets follow the active project; provider events do not share a complete lifecycle snapshot; and conversation, approval, execution, correction, cross-session coordination, and closeout are not one durable state machine.

---

## Product Surfaces

### 1. Session Conversation Controller

The controller owns the lifecycle for one work session. It helps the user explore or diagnose, records the approved plan, supervises execution, answers status questions from snapshots, handles corrections, and manages closeout.

### 2. Executor Lane

Claude, Codex, or another coding executor performs the approved work. It receives approved intent and explicit corrections, not every conversational utterance. Existing provider behavior is normalized into a shared executor snapshot.

### 3. Coop Workspace Coordinator

Coop operates above projects and sessions. It resolves names and topics, triages attention, narrates cross-session status, changes conversational focus, and routes approved instructions. It does not replace the session controller or coding executor.

### 4. Remote Audio Endpoint

A phone can become the selected microphone and speaker for a conversation whose visual UI is on a laptop or desktop. The phone connects to the Clay daemon and session directly; it is not merely a browser microphone forwarded through a laptop tab.

### 5. Minimal Android Companion

The native app supplies reliable microphone capture, audio playback, focus, Bluetooth routing, foreground service behavior, and lock-screen or notification controls. It exposes only the controls and context needed for conversation.

### 6. Multi-Mate Conversation Room

Several Mates may work within one task while a moderator controls the audible floor. This is a later collaboration mode, independent of Coop's cross-workspace role.

---

## Core Architecture

```text
                            Clay daemon
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Persistent conversation channel                                    │
│       │                                                              │
│       ├── Coop workspace coordinator ── target resolver / triage     │
│       │          │                                                   │
│       │          └── project + session focus                         │
│       │                                                              │
│       └── Session conversation controller                            │
│                  │                                                   │
│                  ├── conversational model                            │
│                  │      └── proposed response / typed action         │
│                  ├── lifecycle + plan/decision ledger                │
│                  ├── policy + deterministic control gateway          │
│                  └── read-only normalized executor snapshot          │
│                                      │                               │
│                                      v                               │
│                         Claude / Codex / other executor               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
           ▲ control, transcript, state          ▲ media/signaling
           │                                     │
    Desktop/PWA UI                    Browser phone / Android companion
```

The active project WebSocket is currently replaced when the browser switches projects. Coop must therefore use a persistent daemon-level coordination channel that is independent of the selected project connection. Changing visual focus is a client command, not a prerequisite for querying or routing work.

The explicit action flow is:

```text
Human media or text
    → confirmed transcript
    → conversational model
    → proposed response or typed action
    → daemon policy and deterministic control gateway
    → coding executor or durable lifecycle transition
```

Single-endpoint media transport may be device-to-provider or device-to-daemon depending on the selected provider and privacy mode. Remote endpoint handoff requires hard input and output fencing, so the initial phone endpoint uses daemon-mediated media: the phone sends audio to Clay, Clay connects to the provider, and Clay sends synthesized audio only to the current output endpoint.

A later direct device-to-provider transport is acceptable only if the provider connection can be bound to a lease epoch, revoked by the daemon, and tested to suppress stale input and playback after handoff or partition. In every topology, confirmed transcripts, tool proposals, sequence numbers, and lifecycle changes must be mirrored through the daemon before they become durable or actionable. Control state, authorization, session identity, and durable decisions always flow through Clay.

---

## Independent State Models

A single “listening/thinking/speaking” state is insufficient. Four state machines must remain independent so the UI and speech layer can tell the truth.

### Media state

```text
idle → listening → transcribing → speaking
  ↘ reconnecting / interrupted / failed
```

### Work lifecycle

```text
exploration or diagnosis
        ↓
proposed plan
        ↓
approved plan
        ↓
executing → verifying → closeout → complete
                  ↘ blocked
```

### Executor state

```text
idle / working / waiting-for-input / paused / stopped / failed / completed
```

### Conversational focus

```text
Coop / project / session / no target
```

Example: Clay may be listening while an executor is working on an approved plan in another session and Coop is the current focus. None of those states should overwrite another.

---

## Two-Lane Conversation Model

### Conversation lane

The conversation lane may:

- Explore, challenge, explain, and ask questions
- Read plan versions, decisions, and executor snapshots
- Summarize status and caveats
- Propose a plan, correction, or action
- Ask the user to approve a specific plan version
- Resolve Coop targets and switch focus

### Executor lane

The executor lane may receive:

- An approved plan version
- An approved intent change
- A deterministic pause, continue, stop, or permission response
- Explicit information requested by the executor

A status question must never enter the executor input queue. “What are you doing?” reads a snapshot. “Stop” invokes the control gateway. “Change the button to blue instead” creates an intent diff, explains the affected work, and enters the executor lane only after any required revised plan is approved.

### Normalized executor snapshot

Every provider adapter should reduce provider-specific events into:

- Project, session, provider, and human-readable task title
- Lifecycle phase and executor state
- Current activity and last meaningful progress
- Approved plan version and active acceptance criteria
- Pending decision, permission, or question
- Tests and verification already performed
- Errors, blockers, caveats, and calibrated confidence
- Last update time and whether the snapshot may be stale

Snapshots are durable enough to answer status after reload or handoff, but never contain raw chain-of-thought.

---

## Plans, Decisions, and Corrections

### Intent commits

An intent commit is a durable product record, not a Git commit. It contains:

- The user's goal in plain language
- The selected approach and rejected material alternatives
- Acceptance criteria
- Constraints and known caveats
- Plan version and approval identity/time
- Links to the executing session and resulting work

### Approval semantics

- Approval always references an immutable plan version.
- Editing a plan creates a new version and invalidates the previous approval.
- Approval binds verified human-input provenance, the immutable project/session ID, and the exact plan version.
- Spoken approval is visible in the shared transcript and confirmed by the UI. Low-confidence recognition, an unclear version, or an unclear target requires a short read-back and explicit confirmation before approval is accepted.
- Ambiguous phrases such as “sounds reasonable” may be conversational agreement but do not approve implementation.
- The user can approve by voice or text; both invoke the same typed gateway action.
- Synthesized speech, another agent, replayed audio, copied transcript text without live human provenance, and model-generated tool output can never approve a plan.

### Pre-approval and mutation boundary

Before approval, Clay may converse, inspect state, search, investigate with read-only tools, reproduce an issue in a non-mutating way, and draft or revise the plan. It may not edit files, mutate a repository or runtime, send implementation instructions to an executor, or take external action.

The approved plan authorizes only the implementation, tests, verification, and repository/runtime steps it names. A change to the goal, selected approach, constraints, or acceptance criteria creates a new plan version and requires new approval. Factual answers and execution details already covered by the approved plan do not create a new plan version.

Destructive actions, deployment, publishing, merging, external messages, purchases, or other separately permission-gated operations retain their own authorization requirements unless the exact action is explicitly covered by the plan and Clay's applicable policy allows that authorization to be combined.

An executor reporting that it finished transitions the lifecycle to `verifying` or `closeout`, never directly to `complete`. Only verified human use of `CONFIRM_DONE` marks the work complete. `REOPEN_WORK` returns a closed task to the appropriate earlier phase while preserving its decision history.

### Correction diffs

When intent changes during execution, Clay should state:

1. What changed
2. Which completed or active work is affected
3. Which acceptance criteria changed
4. Whether the existing plan remains valid or requires a new approval
5. What Clay recommends doing next

This makes corrections surgical instead of restarting the whole task or silently ignoring prior work.

---

## Deterministic Control Gateway

The conversational model may recognize and propose controls, but only typed gateway operations change authoritative state.

Initial operations:

- `STOP`
- `PAUSE`
- `CONTINUE`
- `GET_STATUS`
- `FOCUS_TARGET`
- `APPROVE_PLAN_VERSION`
- `REJECT_PLAN_VERSION`
- `REQUEST_PLAN_REVISION`
- `SEND_APPROVED_INTENT`
- `ANSWER_PERMISSION`
- `END_CONVERSATION`
- `CONFIRM_DONE`
- `REOPEN_WORK`

Each operation includes a target, idempotency key, authorization context, and result. Destructive, external, or permission-gated actions retain Clay's existing confirmation rules. Neither speech synthesis nor text generated by another agent can self-approve an action.

“Stop talking” and “stop the work” are different operations. If the target is unclear, Clay stops speech immediately because that is reversible, then asks whether the executor should also stop.

---

## Real-Time Voice Layer

### Requirements

- Natural full-duplex conversation rather than composer dictation
- Streaming input transcription and output speech
- Voice activity and end-of-turn detection with manual fallback
- Barge-in that stops audible output immediately
- Echo cancellation and protection against retranscribing Clay's speech
- A visible shared transcript with clear provisional and confirmed text
- Provider-independent events and capability negotiation
- Text input and controls available at all times
- Accessibility equivalents for every audio-only state

### Provider strategy

Start with one production-quality real-time voice adapter behind a replaceable interface. OpenAI Realtime is the initial candidate because it supplies low-latency audio, interruption, and tool-capable sessions. Provider-specific media events must not become Clay's conversation protocol.

The existing Web Speech API module remains useful as dictation, a degraded fallback, and a test harness. It is not the foundation of the full conversation experience. LiveKit may become useful later if Clay needs managed WebRTC rooms, media routing, or more complex multi-participant infrastructure; it is not required for the first vertical slice.

### Spoken response policy

- Speak conclusions, questions, decisions, meaningful status changes, blockers, and caveats.
- Do not narrate logs, tool calls, token-by-token implementation, secrets, or repetitive progress.
- During execution, status is generated from snapshots and should be short by default.
- Long output appears in the transcript with an offer to summarize or explain it aloud.

---

## Phone as a Remote Microphone and Speaker

This mode lets a user work visually on the web app while using a phone as the audio endpoint. It is useful when the laptop microphone is poor, the user is moving around, or a phone-connected Bluetooth headset is more convenient.

### Interaction model

1. The desktop displays a QR code or short-lived pairing code.
2. The phone opens Clay in a mobile browser or installed PWA and confirms the daemon and target session.
3. The user selects the phone as input, output, or both.
4. The desktop remains the primary visual surface while the phone shows only essential conversation state and controls.
5. Either device can relinquish or transfer the audio role without changing the underlying session.

### Endpoint rules

- Exactly one endpoint holds the active microphone lease by default.
- Exactly one endpoint is the audible output by default.
- Every lease has a monotonically increasing epoch/fencing token. After a handoff, the daemon and media receiver reject packets from every older epoch immediately.
- Input frames and output chunks carry the current epoch. The daemon accepts microphone frames and emits synthesized audio only for that epoch.
- Endpoint changes are explicit and immediately visible on all connected clients.
- A disconnected phone may reserve ownership for a short reconnect grace period, but a newly issued epoch immediately fences the old connection so a network partition can never produce two accepted microphones.
- Output handoff is break-before-make. Clients flush queued playback on revocation or lease expiry. The new output begins only after the old endpoint acknowledges revocation; if acknowledgement is unavailable, Clay waits for the old short-lived playback lease to expire before activating the new endpoint.
- Output buffers remain shorter than the playback lease, and clients check the local lease deadline before playing every chunk. This prevents overlapping narration during a network partition at the cost of a bounded handoff delay.
- Playback never runs on both phone and laptop unless the user deliberately enables it.
- The phone can stop speech or work even if the desktop tab is backgrounded.
- Pairing grants only the scoped conversation capabilities requested, not unrestricted daemon access.

### Security and reliability

- Use TLS for remote connections and reject insecure non-loopback pairing by default.
- Use a one-time pairing flow and a revocable device credential stored with platform-appropriate protection.
- Display the daemon identity, project, session, microphone state, and selected route before capture begins.
- Never activate the microphone from a remote command without a local user action and platform permission.
- Define behavior for phone lock, browser suspension, Wi-Fi/cellular handoff, daemon restart, and duplicate endpoints.

### Initial connectivity topology

Phase 3A supports Android Chrome or the installed Android PWA connecting to the same existing Clay daemon origin over HTTPS. That origin must already be reachable from the phone through a trusted same-LAN HTTPS setup, VPN, or user-managed secure reverse proxy. The QR code carries the verified daemon origin and a one-time scoped pairing secret; it does not create network reachability.

The daemon is the media relay for the first remote-endpoint slice, but this does not introduce a Clay-hosted network relay or tunnel. Plain HTTP is allowed only for loopback development and is not a supported phone-pairing topology. If real use shows that trusted daemon reachability is the dominant setup barrier, a scoped hosted relay or guided certificate/tunnel feature requires a separate security design.

### Browser-first proof

Prove remote audio in Android Chrome and the installed Android PWA before native Android work. The result determines which failures are browser limitations and which are protocol or product problems. A browser proof is successful even if background and lock-screen behavior remain deliberately limited.

---

## Coop: Workspace Voice Coordinator

Coop is a persistent, addressable coordinator above the active project. It provides a stable conversational entry point when several sessions are running.

### Core jobs

1. **Resolve** — find a project or session by task, topic, title, recent activity, provider, or state.
2. **Triage** — identify what needs the user's attention across all work.
3. **Narrate** — summarize meaningful progress, decisions, failures, and completions without reading raw logs.
4. **Focus** — change which project or session the user is talking to and optionally focus the web UI there.
5. **Route** — deliver approved intent, permission answers, or control operations to the chosen target.

### Example language

- “Coop, what needs me?”
- “Get me the one working on voice mode.”
- “Which sessions are still running?”
- “Summarize project A, then switch to Y.”
- “Go to project A and start working on Z.”
- “Pause everything except the release fix.”
- “Tell me when either of those reaches a decision.”

### Target resolution

Reuse Clay's existing cross-project session metadata and palette search as inputs. Resolution should score:

- Explicit project or session name
- Task title and recent transcript summary
- Current and recent activity
- Pending decision or blocker
- Provider and Mate identity
- User's recent conversational focus

Coop states the resolved target before acting: “I found ‘Voice conversation roadmap’ in Clay, session 14. Switching to it.” If two targets are plausible, it asks a short disambiguation question. Misrouting an instruction is worse than asking once.

Resolution returns an immutable project ID, session ID, and target revision/generation token. Every routed control, intent, approval, and permission answer revalidates that binding at dispatch. Changing visible focus cannot retarget an in-flight utterance. A permission answer also binds the exact pending request ID and expires when that request is resolved, withdrawn, or replaced.

Bulk commands such as “pause everything except the release fix” are not part of the first Coop slice. When added, Coop must narrate the complete target set and require explicit confirmation before dispatching the batch.

### Attention queue

Coop maintains a derived queue of:

- Permissions or decisions awaiting the user
- Blocked work
- Failed tests or runtime verification
- Material plan deviations
- Completed work awaiting closeout
- Stale sessions whose state may no longer be trustworthy

Routine progress remains silent. The user can request a full rollup, but unsolicited narration is reserved for subscribed or urgent events.

### Scope and permissions

- Coop uses the caller's existing project and session permissions.
- It may read normalized snapshots and durable summaries, not hidden reasoning.
- It may create or focus a session when asked.
- A new implementation request still goes through exploration or diagnosis, a proposed plan, and explicit plan approval in its target session.
- Only approved instructions enter executor transcripts. Coop's own navigation and triage conversation stays in a workspace-level conversation ledger.

### Persistent channel

Coop cannot depend on the currently selected project's WebSocket. Introduce a dedicated, long-lived daemon coordination channel and module rather than expanding the current global bootstrap handler into a second god object. Project connections continue to carry project-local streaming; the coordination channel carries focus, snapshots, attention events, and routing acknowledgements.

---

## Minimal Native Android Companion

### Goal

Support native phone hardware and Android lifecycle behavior with the smallest maintainable application. The full Clay UI stays in the PWA/web app.

### Proposed shape

Prefer a small native Kotlin/Compose client and service over a full WebView shell. A WebView wrapper duplicates the browser surface without solving the hardest hardware problems. The companion needs only:

- Pairing and connection diagnostics
- Current Coop/project/session identity
- Separate `Listening/Speaking` and `Working/Waiting` indicators
- Push-to-talk, conversation mode, mute, stop speech, pause/stop work, and end controls
- Audio input/output route selection
- A foreground notification and lock-screen/headset actions
- A short transcript/status view for confidence and recovery

### Native responsibilities

- Microphone capture and streaming audio playback
- Android audio focus and phone-call interruption handling
- Bluetooth, wired headset, and device speaker routing
- Foreground microphone service with a visible notification
- Background and screen-lock continuity within Android restrictions
- Media session integration for headset, notification, and lock-screen controls
- Secure device credentials
- Deep links to the correct web project and session

### Android constraints to design around

- Microphone foreground services require the microphone service type and permission declarations.
- Android's while-in-use microphone restrictions generally require the service to start while the app is visible.
- Foreground services must remain visible to the user through a notification.
- Audio focus must be requested and handled; phone calls or other media may pause or duck Clay.
- A media session service supplies robust system, headset, notification, and lock-screen playback controls.

### Native entry gate

Begin implementation after the browser remote-audio proof identifies concrete failures involving at least one of:

- Background or screen-off conversation
- Browser microphone or playback suspension
- Bluetooth routing or audio focus
- Headset and lock-screen controls
- Mobile lifecycle recovery

Do not require a broad usage threshold before building the companion: the stated goal is native hardware support for a daily workflow. The gate is technical learning and protocol stability, not market validation.

### Native exit criteria

- A paired phone can become the audio endpoint for an existing web session.
- An active conversation survives expected background and screen-lock transitions.
- Bluetooth connect/disconnect and phone-call interruption recover without duplicating a turn.
- Foreground, lock-screen, notification, and headset controls invoke the same deterministic gateway as the web UI.
- The app cannot silently record, speak a secret, or route an action to an ambiguous target.

---

## Multi-Mate Conversation Rooms

Rooms are a later feature for hearing useful contributions from several Mates inside one task.

- The user's approved conversational turn may fan out to selected Mates.
- Mates return structured `answer`, `challenge`, `question`, or `pass` intent.
- A moderator owns the audible floor and may synthesize several contributions.
- All contributions remain visible even when not spoken.
- One slow or failed Mate cannot block the room.
- The moderator can explain why a contribution was selected or skipped.

Room moderation must not be reused as Coop's cross-session routing logic. They have different permissions, state, failure modes, and user expectations.

---

## Persistence, Privacy, and Recovery

### Durable by default

- Conversation lifecycle and focus
- Confirmed transcript text
- Intent commits, decisions, and plan approvals
- Normalized executor snapshots and attention events
- Device registrations, route preferences, and revocations
- Closeout summaries and links to resulting work

### Ephemeral by default

- Raw microphone audio
- Synthesized audio buffers
- Provisional transcript fragments after finalization
- Voice-provider session credentials

### Required protections

- Always display active microphone and selected endpoint state.
- State whether media is processed on-device, by the daemon, or by a third party.
- Never speak secrets, credentials, raw environment values, or unredacted logs.
- Preserve Clay authentication and project permissions on every surface.
- Store user settings server-side so they follow the user across browsers and devices.
- Make pairing revocable and auditable.
- Make every control idempotent so reconnect cannot approve, send, or stop twice.
- Recover from daemon restart without duplicating the last utterance or executor instruction.

---

## Implementation Boundaries in the Current Codebase

Before implementation, re-read `docs/guides/MODULE_MAP.md` and `docs/guides/CLIENT_MODULE_DEPS.md`. The intended boundaries are:

- Keep client state in `lib/public/modules/store.js` or focused store slices.
- Use `lib/public/modules/ws-ref.js` and direct imports for client dependencies.
- Keep dictation compatibility in `lib/public/modules/stt.js`; add focused modules for conversation media, controls, and rendering.
- Reuse `lib/project-user-message.js` only for explicit executor input, not status questions.
- Reuse and extend the deterministic lifecycle behavior in `lib/project-sessions-live.js` and approval handling in `lib/project-sessions-permissions.js` through focused modules.
- Normalize provider events near the existing SDK/YOKE bridges rather than teaching Coop provider-specific formats.
- Reuse cross-project indexing from `lib/server-palette.js` for Coop target resolution.
- Add a focused daemon-level conversation/Coop module and persistent channel instead of adding inline branches to `project.js` or overloading `lib/server-global-ws.js`.
- Keep modules below 500 lines and split protocol, lifecycle, media, snapshot, target resolution, and narration responsibilities.

Existing stalls, reconnects, resume spam, and UI lag are conversation correctness risks. Each implementation phase must use the documented diagnostics and verify that recovery canaries remain quiet.

---

## Delivery Phases

### Phase 0: Alignment, Protocol, and Observability

**Goal**: Lock the product semantics before choosing UI or media details.

- [ ] Define typed control, lifecycle, intent, snapshot, focus, attention, endpoint, and media events.
- [ ] Define idempotency, human-input provenance, authorization, sequence, acknowledgement, and reconnect behavior.
- [ ] Define immutable target bindings, request IDs, and endpoint fencing epochs.
- [ ] Confirm the initial remote endpoint topology and document HTTPS/VPN/reverse-proxy setup requirements.
- [ ] Instrument microphone start, transcript, dispatch, model output, speech, control, routing, and recovery timings.
- [ ] Establish provider-neutral capability negotiation.
- [ ] Add redaction and “never speak” policy tests.
- [ ] Record baseline reconnect and session-lifecycle canary behavior.

**Exit**: The same simulated conversation can run through text, web audio, and a future Android client without changing lifecycle semantics.

### Phase 1: Conversation Kernel

**Goal**: Prove the work lifecycle independently of real-time audio.

- [ ] Implement separate conversation and executor lanes.
- [ ] Implement the four independent state models.
- [ ] Produce normalized executor snapshots for Claude and Codex first.
- [ ] Implement typed control gateway operations.
- [ ] Persist plan versions, approvals, decisions, corrections, and closeout.
- [ ] Make status read-only and non-interrupting.
- [ ] Recover state after reload, restart, compaction, and provider handoff.
- [ ] Exercise the kernel through text and simulated voice events.

**Exit**: Both north-star workflows complete correctly without audio, including approval, status during work, correction, verification, and user-confirmed closeout.

### Phase 2: Web Real-Time Voice Vertical Slice

**Goal**: Make one active session genuinely conversational in desktop Chrome.

- [ ] Add a replaceable real-time voice provider adapter.
- [ ] Stream transcript and speech with barge-in.
- [ ] Keep executor work active while answering status from its snapshot.
- [ ] Support spoken plan review and exact plan-version approval.
- [ ] Add separate stop-speech and stop-work controls.
- [ ] Preserve text as a simultaneous input and recovery path.
- [ ] Validate ephemeral audio and secret redaction.

**Exit**: A user can explore or diagnose, approve, supervise, correct, verify, and close a real task through conversation without using composer dictation.

### Phase 3A: Browser Remote Audio Endpoint

**Goal**: Use a phone browser/PWA as the microphone and speaker for a web-visible session.

- [ ] Add scoped QR/one-time-code pairing.
- [ ] Add endpoint discovery, fenced microphone/output leases, and route handoff.
- [ ] Relay phone input and selected output through the daemon so both directions are authoritatively fenced.
- [ ] Implement break-before-make output handoff: flush on acknowledged revocation or wait for lease expiry before starting the new output.
- [ ] Add a minimal mobile remote-audio screen.
- [ ] Handle phone disconnect, network handoff, duplicate endpoints, and daemon restart.
- [ ] Measure end-to-end remote audio and control latency.

**Exit**: The user can leave the laptop UI open, carry the phone, converse with the same session, and return audio to the laptop without losing state or creating echo.

### Phase 3B: Coop Workspace Coordinator

**Goal**: Navigate and supervise multiple sessions conversationally.

- [ ] Add the persistent daemon coordination channel.
- [ ] Build cross-project normalized snapshot and attention indexes.
- [ ] Add target resolution with explicit ambiguity handling.
- [ ] Add immutable target bindings, focus, triage, narration, and approved-intent routing.
- [ ] Add project/session switch commands for connected web clients.
- [ ] Persist workspace-level Coop conversations and target transitions.
- [ ] Test stale, missing, completed, duplicated, and permission-denied targets.

**Exit**: The user can ask what needs attention, reach a session by topic, act on its pending decision, switch to another project, and start a new task without keyboard or mouse navigation.

Phases 3A and 3B may proceed in parallel after the kernel is stable. Together they create the intended hands-free multi-session experience.

### Phase 4: Minimal Native Android Companion

**Goal**: Replace browser-specific hardware weaknesses without duplicating Clay.

- [ ] Build native pairing and the essential conversation/status screen.
- [ ] Implement native audio capture, playback, focus, and routing.
- [ ] Implement foreground service, media session, notification, headset, and lock-screen controls.
- [ ] Handle Android lifecycle, phone calls, Bluetooth changes, and process recovery.
- [ ] Establish signing, internal distribution, updates, and diagnostics.

**Exit**: The companion meets the native exit criteria and continues the same durable conversation as the web client.

### Phase 5: Rooms and Advanced Orchestration

**Goal**: Add multi-Mate rooms, richer Coop subscriptions, and optional media infrastructure only after the core daily workflow is dependable.

- [ ] Add structured multi-Mate fan-out and moderation.
- [ ] Add Coop subscriptions and concise completion narration.
- [ ] Evaluate LiveKit or another media layer only from measured room/transport needs.
- [ ] Evaluate iOS or other endpoints from real device demand.

---

## Acceptance Journeys

Every phase should preserve these end-to-end journeys:

1. **Fresh idea** — explore, challenge, plan, approve, implement, status, verify, close.
2. **Reported issue** — diagnose, explain evidence/confidence, plan, approve, repair, verify, close.
3. **Non-interrupting status** — ask status during execution without changing the executor queue.
4. **Intent correction** — change one requirement and see the exact work and criteria affected.
5. **Restart recovery** — restart browser or daemon and resume from the same lifecycle and approval state.
6. **Remote phone audio** — use a phone microphone/speaker while the desktop remains the visual surface.
7. **Coop navigation** — find a session by topic, resolve ambiguity safely, switch focus, and act on its pending decision.
8. **Closeout** — report implementation, tests, verification, caveats, repository/runtime actions, and wait for the user's done decision.

---

## Metrics

Track percentiles and failure rates, not only averages.

| Metric | Starts | Ends |
|---|---|---|
| Listening startup | Conversation activation | Microphone accepts audio |
| Partial transcript latency | Word spoken | Word first appears |
| Turn finalization | User finishes | Confirmed intent is available |
| Conversation response | Confirmed intent | First useful spoken response |
| Status response | Status request | Snapshot summary begins |
| Speech interruption | Stop/barge-in | Audio is silent |
| Work control | Pause/stop/continue | Target acknowledges state |
| Target resolution | Coop request | Unique target confirmed or ambiguity asked |
| Action routing | Confirmed target action | Target acknowledges receipt |
| Remote audio latency | Audio captured | Audio is rendered/understood at destination |
| Endpoint handoff | Route change | New route is active and old route is silent |
| Recovery | Connection becomes usable | Durable conversation state is restored |

Quality metrics:

- Target resolution accuracy and misroute count; target misroutes should be zero.
- Approval correctness; no unapproved plan version may execute.
- Status fidelity compared with executor events.
- Correction diff accuracy and unnecessary rework.
- False turn endings, accidental activations, echo loops, and duplicate sends.
- Secret-redaction failures; target is zero.
- Hands-free completion rate for the acceptance journeys.

---

## Executable Safety Invariants

These are release-blocking automated tests, not aspirational requirements:

1. No executor input, file/repository/runtime mutation, or state-changing external action occurs without a valid approval bound to the current immutable plan version and target.
2. A status request produces zero executor-input events.
3. An approved plan version begins execution at most once.
4. Reconnect, replay, and duplicate delivery cannot repeat an approval, control, permission answer, or intent dispatch.
5. A changed, stale, missing, or ambiguous Coop target receives no routed action.
6. Changing visual focus cannot retarget an in-flight utterance.
7. A permission response applies only to its exact still-pending request ID.
8. Executor completion cannot mark the lifecycle `complete`; verified human `CONFIRM_DONE` is required.
9. Only input frames carrying the current microphone lease epoch are accepted.
10. Only one output endpoint can play audio: normal handoff waits for revocation acknowledgement, and partition handoff waits for old-lease expiry before the new endpoint receives playable audio.
11. Voice-provider failure leaves executor work intact and immediately exposes text transcript and deterministic controls.
12. Synthesized, replayed, agent-generated, or low-confidence speech cannot approve a plan or externally consequential action.
13. A plan whose goal, approach, constraints, or acceptance criteria changed cannot execute under the previous approval.
14. Secret fixtures never appear in synthesized speech, narration text, retained transcripts, or conversation diagnostics.

---

## Testing Matrix

### Lifecycle

- Exploration, issue diagnosis, plan revision, approval, execution, verification, closeout
- Status and explanation while executor is working
- Correction before work, during work, and during verification
- Permission question while another session completes
- Reload, daemon restart, compaction, provider handoff, and stale snapshots

### Coop and routing

- One exact target, several similar targets, missing target, completed target, deleted target
- Same task title across projects
- Target without permission
- Target changes state during resolution
- Target revision changes between spoken resolution and dispatch
- Rapid focus changes and a command spoken during a switch
- Multiple simultaneous pending decisions

### Clients and audio

- Desktop Chrome, Android Chrome, installed PWA, native companion
- Laptop and phone microphone/speaker combinations
- Wired and Bluetooth headsets
- Route changes during listening and speaking
- Phone lock, backgrounding, network handoff, disconnect, and incoming call
- Provider timeout, partial outage, and fallback to text

### Safety

- Spoken text that resembles an approval but is not one
- Agent-generated audio attempting to invoke a tool or approval
- Secrets in logs, environment output, transcripts, or status snapshots
- Replayed or duplicated control messages
- Old endpoint audio arriving after a route handoff
- Pairing-token theft, revocation, and expired device permissions
- Stop-speech versus stop-work ambiguity

---

## Non-Goals

- Rebuilding all Clay screens as a native Android application
- Treating speech-to-text in the composer as full conversation mode
- Running Claude Code or Codex directly on the phone
- Allowing several agents or endpoints to speak simultaneously by default
- Sending ordinary status questions into an active executor turn
- Letting Coop silently guess an ambiguous project or session
- Persisting raw microphone audio by default
- Coupling durable conversation state to one voice or coding provider
- Exposing hidden chain-of-thought through snapshots or narration

---

## Remaining Product Questions

These require prototypes or explicit user decisions:

1. Which wake/focus interaction feels safest: “Coop” always addresses the coordinator, or does the name only escape from a focused session?
2. Which Coop events deserve unsolicited narration, and which require a subscription such as “tell me when this finishes”?
3. Should the phone default to both microphone and speaker, or preserve the desktop speaker until explicitly changed?
4. Which real-time voice provider best balances latency, language quality, privacy, cost, and self-hosted deployment?
5. How much transcript should the minimal Android companion show without becoming a second full UI?
6. Is internal APK distribution sufficient initially, or is Play Store distribution needed for installation and update trust?

---

## Recommended First Slice

Do not start with primitive push-to-talk or the Android shell.

Build a narrow vertical slice of the conversation kernel and web real-time voice:

1. One Clay project and one active executor session
2. Exploration or diagnosis leading to a versioned plan
3. Spoken and visible approval of that exact plan version
4. Separate conversational and executor lanes
5. Read-only spoken status while execution continues
6. Deterministic stop speech, stop work, pause, and continue
7. Verification, caveats, and user-confirmed closeout
8. Full timing, persistence, redaction, and restart instrumentation

Once that lifecycle feels dependable, build the phone browser as a remote audio endpoint and Coop's cross-session coordination on the same protocol. Native Android then becomes a focused solution to measured hardware and lifecycle gaps rather than a competing application architecture.

---

## Research References

- [OpenAI Agents SDK voice agents](https://openai.github.io/openai-agents-js/guides/voice-agents/)
- [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime)
- [LiveKit Agents](https://github.com/livekit/agents-js)
- [Android background playback with a MediaSessionService](https://developer.android.com/media/media3/session/background-playback)
- [Android media controls and external controllers](https://developer.android.com/media/media3/session/control-playback)
- [Android audio focus](https://developer.android.com/media/optimize/audio-focus)
- [Android foreground service types and microphone restrictions](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Android foreground services](https://developer.android.com/develop/background-work/services/fgs)

---

## Decision Log

| Date | Decision |
|---|---|
| 2026-07-18 | Treat conversation as a durable product lifecycle, not enhanced dictation. |
| 2026-07-18 | Separate the conversational controller from the coding executor so status does not interrupt work. |
| 2026-07-18 | Require explicit approval of a versioned plan before every implementation. |
| 2026-07-18 | Make plan corrections explicit intent diffs. |
| 2026-07-18 | Keep audio ephemeral and never speak secrets. |
| 2026-07-18 | Use OpenAI Realtime as the initial candidate behind a provider-neutral adapter; keep LiveKit optional. |
| 2026-07-18 | Add phone-as-remote-audio before native Android to validate the shared protocol. |
| 2026-07-18 | Define Coop as a daemon-level workspace coordinator distinct from multi-Mate rooms. |
| 2026-07-18 | Keep Android minimal and native-hardware-focused rather than wrapping the entire web UI. |
| 2026-07-18 | Allow read-only exploration and diagnosis before approval; require approval before implementation or mutation. |
| 2026-07-18 | Require verified human confirmation after verification/closeout before work becomes complete. |
| 2026-07-18 | Fence Coop targets, pending requests, and remote audio endpoints against stale or replayed actions. |
| 2026-07-18 | Use the user's existing HTTPS-reachable daemon origin for the first Android Chrome/PWA remote-audio proof; do not add a hosted relay initially. |
| 2026-07-18 | Relay Phase 3A phone media through the daemon so microphone and output handoffs have enforceable lease fencing. |
