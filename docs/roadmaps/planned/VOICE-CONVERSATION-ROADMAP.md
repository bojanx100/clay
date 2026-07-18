# Voice Conversation Roadmap

> Add a low-latency spoken conversation layer to Clay, prove the experience in the existing PWA, then add a thin Android client only where native mobile capabilities materially improve it.

**Created**: 2026-07-18
**Status**: Planning

---

## Product Decision

Do not begin with a full native Android rewrite.

Clay already ships an installable PWA on Android with a responsive mobile UI, push notifications, a service worker, WebSocket streaming, reconnect handling, and browser speech-to-text. Reuse that foundation to validate the conversation experience first.

An Android client becomes worthwhile when Clay needs capabilities the browser cannot deliver reliably enough:

- Continuous microphone capture while the screen is locked or Clay is in the background
- Audio focus and interruption handling
- Bluetooth and headset routing
- Lock-screen playback controls
- Reliable spoken notifications and conversation resume
- Lower-level control over echo cancellation, playback, and microphone state

Native Android does not make Claude, Codex, or other models generate answers faster. Perceived speed comes primarily from streaming every stage, parallelizing independent agent work, and letting the user interrupt work that is no longer useful.

---

## Vision

A user can talk naturally to one Clay AI or a room of Mates from a phone:

1. The user starts speaking.
2. Clay shows an immediate live transcript.
3. The selected AI begins preparing an answer before the user has waited through avoidable UI steps.
4. Spoken output starts as soon as useful text is available.
5. The user can interrupt, redirect, or stop the answer at any time.
6. In a multi-AI room, agents work in parallel while one moderator controls the audible conversation.

The experience should feel like calling a capable teammate, not dictating into a text box.

---

## Current Foundation

Clay already has:

- Installable PWA metadata in `lib/public/manifest.json`
- Offline shell and push handling in `lib/public/sw.js`
- PWA install flow in `lib/public/modules/app-misc.js`
- Push notification controls in `lib/public/modules/notifications.js`
- WebSocket streaming and wake/reconnect handling in `lib/public/modules/app-connection.js`
- Continuous browser speech recognition in `lib/public/modules/stt.js`
- Vendor-neutral agent execution through YOKE
- Persistent Mates and structured multi-Mate debates

The existing speech-to-text module transcribes speech into the composer. It does not yet provide streaming audio output, interruption, turn detection, or a continuous conversation state.

---

## Guiding Principles

1. **Conversation first, Android second.** Prove the interaction before adding another distributed client.
2. **One audible speaker.** Multiple agents may think in parallel, but only the user or one selected AI speaks at a time.
3. **Stream every stage.** Do not wait for a complete recording, transcript, model answer, or synthesized audio when partial results are usable.
4. **Interruption is mandatory.** A user must be able to stop or redirect an AI without waiting for its current response to finish.
5. **Keep the daemon authoritative.** Sessions, orchestration, settings, and history remain on the Clay host. Mobile clients stay replaceable.
6. **Make privacy visible.** The UI must state where speech recognition and synthesis happen and when audio leaves the device.
7. **Measure before rewriting.** Promote a capability to native Android only after browser testing identifies a concrete reliability or product gap.

---

## Experience Levels

### Level 1: Voice Input

The user taps the microphone, speaks, reviews the transcript, and sends a normal Clay message.

This mostly exists today.

### Level 2: Push-to-Talk Conversation

The user holds or taps to speak. Clay automatically sends the completed utterance and reads the answer aloud. The user can stop playback immediately.

This is the smallest useful conversation layer and the first milestone to ship.

### Level 3: Live Conversation

Clay detects the end of a spoken turn, starts the response automatically, streams speech back, and supports barge-in while the AI is talking.

### Level 4: Multi-AI Room

Several Mates receive the same turn and work in parallel. A moderator decides which response should be spoken, requests a challenge when useful, and prevents repetitive answers.

### Level 5: Phone-Native Conversation

The conversation survives backgrounding, screen lock, Bluetooth changes, phone calls, and Android process suspension. Lock-screen controls expose pause, resume, mute, and end-conversation actions.

---

## Architecture Direction

```text
Microphone
    |
    v
Voice activity / turn detection
    |
    v
Streaming transcription
    |
    v
Clay conversation controller
    |------------------------------|
    v                              v
Single agent                 Multi-agent fan-out
                                   |
                                   v
                            Moderator selection
    |------------------------------|
    v
Streaming text response
    |
    v
Streaming speech synthesis
    |
    v
Speaker / headset
```

The conversation controller belongs in the shared Clay protocol and daemon architecture. The PWA and a future Android shell should use the same session state and message contract.

---

## Phase 0: Baseline and Protocol

**Goal**: Define what “fast conversation” means and prevent the first UI prototype from locking Clay into one speech provider.

### Deliverables

- [ ] Record timestamps for microphone start, first interim transcript, final transcript, message dispatch, first model token, first synthesized audio, and playback end
- [ ] Define a conversation state machine covering idle, listening, transcribing, thinking, speaking, interrupted, reconnecting, and failed states
- [ ] Define client-to-daemon events for starting, stopping, interrupting, and resuming a conversation
- [ ] Define daemon-to-client events for transcript updates, agent status, spoken-response chunks, and recoverable failures
- [ ] Decide whether raw audio passes through the daemon or goes directly to a configured speech provider
- [ ] Add explicit capability negotiation so a PWA and future Android client can share the protocol

### Exit Criteria

- Every conversation stage has observable timing data.
- A provider can be replaced without changing the conversation UI contract.
- Reconnect behavior is defined before live audio work begins.

---

## Phase 1: PWA Push-to-Talk

**Goal**: Ship the smallest end-to-end spoken conversation using the existing web client.

### Deliverables

- [ ] Add a conversation mode separate from composer dictation
- [ ] Automatically send a completed utterance
- [ ] Stream the agent response into speech playback
- [ ] Add stop, replay, mute, and exit-conversation controls
- [ ] Show listening, thinking, and speaking states without hiding the text transcript
- [ ] Persist conversation preferences server-side
- [ ] Recover cleanly from microphone denial, speech-provider failure, WebSocket disconnect, and an interrupted agent turn
- [ ] Verify behavior in Android Chrome and the installed Android PWA

### Exit Criteria

- A user can complete a five-turn hands-free test without touching the text composer.
- Spoken playback begins before the full model response is complete.
- Stop playback and cancel generation feel immediate.
- The transcript remains a normal Clay session that can continue on desktop.

---

## Phase 2: Live Conversation and Barge-In

**Goal**: Replace the push-to-talk rhythm with a natural turn-taking loop.

### Deliverables

- [ ] Add voice activity detection and configurable end-of-turn timing
- [ ] Support barge-in by stopping playback and cancelling or steering the active agent turn
- [ ] Prevent Clay's own speaker output from being retranscribed as user speech
- [ ] Stream partial transcripts without duplicating or losing confirmed words
- [ ] Resume safely after brief mobile network loss
- [ ] Provide a clear manual fallback when automatic turn detection is wrong
- [ ] Add accessibility alternatives for every audio-only state

### Exit Criteria

- Users can interrupt an AI consistently without echo loops.
- Silence and background noise do not create accidental messages during normal use.
- A reconnect does not duplicate the user's last utterance or the AI's last spoken segment.

---

## Phase 3: Multi-AI Conversation Rooms

**Goal**: Let users talk with multiple Mates without multiplying wait time or producing an unusable wall of voices.

### Interaction Model

- The user's utterance fans out to selected Mates in parallel.
- One moderator owns the audible floor.
- Mates can return `answer`, `challenge`, `question`, or `pass` intent.
- The moderator may speak one answer, synthesize several answers, or invite a short challenge.
- All contributions remain visible in the transcript even when they are not spoken.

### Deliverables

- [ ] Add a conversation-room configuration for participants and moderator
- [ ] Run independent Mate work in parallel
- [ ] Add response deadlines so one slow Mate cannot block the room
- [ ] Add deduplication and disagreement detection before speech synthesis
- [ ] Show which Mates are thinking, ready, selected, or skipped
- [ ] Let the user address a specific Mate by name
- [ ] Let the user ask for another opinion without repeating the original prompt
- [ ] Track per-Mate latency and moderator decisions for evaluation

### Exit Criteria

- Adding a second Mate does not double the normal response delay.
- Only one synthesized voice plays at a time.
- The moderator can explain why a Mate was selected or skipped.
- A failed or slow Mate does not end the conversation.

---

## Phase 4: Thin Android Client

**Goal**: Add native Android capabilities while reusing the Clay web interface and conversation protocol.

### Proposed Shape

Use a thin Android shell, likely Capacitor or an equivalent WebView bridge, rather than rebuilding the complete interface in Kotlin or Compose. Keep ordinary Clay screens web-based and expose only the native capabilities the conversation experience needs.

### Native Responsibilities

- Microphone capture and audio playback
- Audio focus and phone-call interruption handling
- Bluetooth and wired-headset routing
- Foreground conversation service
- Background and lock-screen controls
- Android notification actions
- Secure storage for connection credentials
- Deep links back to the correct Clay project and session

### Deliverables

- [ ] Build a signed internal Android package that connects to an existing Clay daemon
- [ ] Bridge native audio events into the shared conversation protocol
- [ ] Handle Android lifecycle events without duplicating messages or losing session state
- [ ] Add QR-based server pairing and connection diagnostics
- [ ] Add a clear foreground-service notification while the microphone is active
- [ ] Document VPN, LAN, certificate, and self-hosted connection requirements
- [ ] Establish automated builds, signing, versioning, and release distribution

### Android Entry Gate

Begin this phase only if Phase 1 or Phase 2 testing confirms at least one of these:

- Users regularly need background or screen-off conversation.
- Browser microphone or playback behavior fails often enough to break normal use.
- Bluetooth routing or audio focus is a core use case.
- Android lifecycle suspension causes unacceptable conversation loss.
- Play Store distribution materially improves onboarding or trust.

### Exit Criteria

- A conversation survives screen lock and app backgrounding.
- Bluetooth connect and disconnect events recover without restarting the session.
- An incoming phone call pauses Clay and resumes safely afterward.
- The Android client and PWA can open and continue the same conversation.

---

## Phase 5: Full Native UI Decision

**Goal**: Decide from evidence whether any part of Clay should become a fully native Android interface.

A full native rewrite is justified only if mobile conversation becomes a primary Clay workflow and the WebView creates persistent usability or performance limits that a bridge cannot solve.

### Decision Inputs

- Share of active users who use mobile conversation weekly
- Average conversation duration and background usage
- Crash, reconnect, and audio-routing failure rates
- Measured UI or audio latency attributable specifically to the WebView
- Cost of maintaining separate web and Android interfaces
- User demand for Android-only interaction patterns

The default decision is to keep the shared web UI.

---

## Performance Metrics

Track percentiles, not only averages, for:

| Metric | Starts | Ends |
|---|---|---|
| Listening startup | User taps or activates conversation | Microphone is accepting audio |
| Partial transcript latency | User speaks a word | Word first appears on screen |
| Turn finalization latency | User stops speaking | Utterance is dispatched |
| Model response latency | Utterance is dispatched | First useful model output arrives |
| Speech startup latency | First useful model output arrives | First audio is audible |
| Interruption latency | User begins barge-in or taps stop | AI audio stops |
| Multi-AI selection latency | User turn is dispatched | Moderator selects the audible response |
| Recovery latency | Connection becomes usable again | Conversation returns to a valid state |

Performance work should target the largest measured delay. Do not attribute model or orchestration latency to the mobile client.

---

## Privacy and Safety Requirements

- [ ] Always show when the microphone is active
- [ ] Never begin background recording without an explicit user action
- [ ] Show whether transcription is on-device, daemon-hosted, or sent to a third party
- [ ] Do not persist raw audio by default
- [ ] Give users separate controls for transcript retention and optional audio retention
- [ ] Prevent synthesized speech from triggering tools or approvals without the same confirmation rules as text
- [ ] Preserve Clay authentication and project permissions across every client
- [ ] Redact secrets from conversation diagnostics

The current Web Speech API implementation can send audio to Google-operated recognition services. Conversation mode must make that dependency visible and support replacing it.

---

## Testing Matrix

### Clients

- Android Chrome
- Installed Android PWA
- Thin Android shell when Phase 4 begins
- Desktop Chrome as the continuity baseline

### Audio

- Phone microphone and speaker
- Wired headset
- Bluetooth headset
- Bluetooth connection changes during a response
- Media playback from another app
- Incoming phone call

### Environment

- Same LAN as the Clay daemon
- VPN connection
- Network handoff and brief offline period
- Screen lock and backgrounding
- Daemon restart during a conversation
- Speech provider timeout or partial outage

### Conversation

- Single AI
- Two fast Mates
- One fast and one stalled Mate
- Moderator failure
- User interruption during model generation
- User interruption during speech playback
- Rapid successive turns

---

## Non-Goals

- Rebuilding all Clay screens in native Android before conversation usage proves the need
- Running Claude Code or Codex directly on the Android device
- Allowing several AIs to speak over one another
- Hiding third-party speech processing from the user
- Persisting raw microphone audio by default
- Coupling conversation state to one speech or model provider

---

## Open Product Questions

1. Should the first release use push-to-talk or automatic end-of-turn detection?
2. Should Clay speak every answer by default, or only when conversation mode is active?
3. Does the user choose a single voice for the room or a distinct voice per Mate?
4. When Mates disagree, should the moderator synthesize the disagreement or let one Mate challenge another aloud?
5. Should the first speech provider prioritize local privacy, lowest latency, broad language coverage, or easiest deployment?
6. Is Play Store distribution important, or is a directly installed package sufficient for early testing?

---

## Recommended First Slice

Start with Phase 0 and a narrow Phase 1 prototype:

1. One AI only
2. Push-to-talk
3. Existing browser transcription
4. Streaming speech playback
5. Immediate stop and cancel
6. Full timing instrumentation
7. Android Chrome and installed-PWA testing

This slice answers the most important question: does talking to Clay create enough value to justify deeper audio and Android work?
