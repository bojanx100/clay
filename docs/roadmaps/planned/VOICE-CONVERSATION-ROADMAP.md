# Clay Conversation Roadmap

> Make Clay usable as an ongoing conversation: think together, agree on an explicit plan, supervise execution, make corrections, verify completion, and move between projects and sessions with minimal keyboard or mouse use.

**Created**: 2026-07-18
**Rewritten**: 2026-07-18 (v2 — grounded in empirical mining of 425 Claude Code sessions and 592 Codex rollouts; provider strategy rebuilt around zero-marginal-cost constraint)
**Status**: Planning
**Working coordinator name**: Coop

---

## Product Decision

The product is a **Conversation Engine**, not a speech-to-text feature and not an Android rewrite.

Voice is one transport into the same durable conversation lifecycle used by text. Clay must understand whether the user is exploring an idea, diagnosing an issue, approving a plan, supervising implementation, asking for status, correcting intent, or deciding that work is complete. Audio alone does not provide that understanding.

Build the shared conversation kernel and protocol first, but prove it **with real voice attached from the first slice** — the riskiest unknown is not the state machinery (which is just work), it is what conversation with a coding agent *feels* like: turn-taking, what deserves to be spoken vs shown, whether spoken plan review is tolerable, whether status answers feel alive or canned. Those can only be learned with audio on.

Then add:

1. Cross-device conversation continuity so a user can begin on the web, pick up a phone, and continue the same live conversation in either direction.
2. Coop, a workspace-level voice coordinator for finding, triaging, and switching between projects and sessions.
3. A deliberately small native Android companion for the hardware and lifecycle capabilities browsers cannot provide reliably.

Do not rebuild ordinary Clay screens in Android. The daemon remains authoritative, the web app remains the full visual interface, and every client uses the same conversation state and control protocol.

**Hard cost constraint (owner decision, 2026-07-18)**: the feature must run on existing subscriptions — Claude Team (drives Claude Code via Agent SDK OAuth), ChatGPT Pro (drives Codex via app-server auth), GitHub Copilot. **No new per-minute or per-token API spend may be required for the core experience.** Paid voice providers are allowed only as optional, pluggable upgrades. This constraint decides the architecture (see *Voice Architecture Decision* below).

---

## What the Data Says

Before designing the conversation model, we mined the user's real archives — every conversational claim in this roadmap traces to one of these findings. Corpus: **425 Claude Code sessions** (urban-stay 65, clay 96, v2-webapp 264; 125 deep-extracted, all scanned for rare events) and **592 Codex rollouts** (~846 MB, all parsed; 420-message classified sample + 1,697 agent→user adjacency pairs). ~668 Claude-side and ~2,850 Codex-side genuinely human-typed messages. Methodology and artifacts in Appendix B.

### F1 — Barge-in is a myth for this user; steering is turn-boundary

Mid-turn interrupts across ~950 sessions: **≈6 in Claude Code, 5 `turn_aborted` in 592 Codex sessions.** All steering happens between turns or via a typed queued message. The word `stop` is typed (10× Codex, 1× urban-stay) rather than the interrupt button pressed.
→ *Voice barge-in must mean "queue a steer", never "abort the turn". Abort is the explicit word "stop", and even then stop-speech before stop-work (speech is reversible).*

### F2 — "continue" is the single most frequent utterance

76× exact in Codex, 15× urban-stay, 41 keep-going nudges in clay/v2-webapp. Plus presence checks whenever the agent is slow: "alive?", "You ok", "you there", "did you stop again?".
→ *A `NUDGE` fast-path (zero-token, deterministic) and proactive spoken progress ("still building…") that preempts presence checks.*

### F3 — The approval vocabulary is tiny, lowercase, and typo-ridden

Observed pure approvals, by frequency: `continue`, `yes`, `ok do it` (26×), `do it`, `ok`, `go`, `sure`, `do that`, `do both`, `ship it`, `add it`, `implement`, `let's do it`, `please do`, bare option tokens `1` / `a` / `B` / `num 3`, and emphasis-caps `DO ALL MODULES`. **Never** "approved", "LGTM", or "sounds good, proceed".
→ *Spoken approval detection keys on a small closed phrase set + option-token resolution against the agent's last enumeration — not on formal language.*

### F4 — Approvals carry riders; plans are edited, not rejected

~1 in 3 approvals is conditional or fused with the next command: "yes, and commit and push", "Yes, but keep Analytics top-level", "ok try it but don't commit untill I'm happy with it", "do b2 and C, but…", "1 yes, 2 not needed". And in the entire 425-session corpus there were only **6 formal ExitPlanMode plans — all 5 approvals were "Approved Plan (edited by user)"; zero rejections.** The real revision channel is *amend-then-approve*.
→ *`APPROVE_PLAN_VERSION` alone is wrong. The gateway needs `APPROVE_WITH_AMENDMENT` (amendment creates the new version and approves it atomically) and fused approval+dispatch ("yes, and push" = approve + queue ops command).*

### F5 — Corrections split ~60/40 minor/material, with recognizable material markers

Minor corrections are verbless fragments: "also the color", "no need for two emails", "just the lower line", "reduce length of spikes by just a bit, 10%". Material corrections open with **"you missunderstood" / "you missed the point" / "i said" / "like I said" / "no no no"** and often re-state the whole flow as a numbered list.
→ *Two-tier correction routing: minor → steer into the executor (Clay's existing steer path) with no ceremony; material → intent diff + plan re-version + re-approval. The markers above are the classifier features.*

### F6 — The debug/verify loop is the product, not the new-task flow

~35% of all typed traffic is the loop: bug report (often screenshot-first) → fix claim → user tests → "didn't work" / "still no go" / "still flashing…" → fix → terse pass ("works now", "seems to b4e ok now"). "New task" is only 7–9%. Done-claims are immediately contested **5–10%** of the time in Claude sessions and **up to a quarter to a third** in UI-heavy Codex work (counting negative screenshot replies). Typical rounds to actually-done: 1–3, tail 4–5.
→ *After speaking a completion, keep the just-finished context hot and expect "still broken" as the next utterance. Never treat "done" as closing.*

### F7 — Screenshots are load-bearing; voice needs the visual channel

10–18.5% of Claude-side messages and 14% of Codex-side messages carry images; some are image-only ("here", "another one", or literally no text). 24% of post-done Codex replies are screenshots. Deixis is heavy: "just the lower line", "this goes to new row", "same apply for this".
→ *Voice is a companion to the screen, not a replacement. The engine needs turn-scoped anaphora resolution (resolve "this" against the last agent utterance / current view) and a spoken escape hatch: "I'll send a screenshot" pauses the turn awaiting an image.*

### F8 — Multi-intent utterances are routine

6–15% of messages chain intents: "why didn't address come from guesty… and why don't we parse doc on choose file… and please buttons still have no feedback" (3 bug reports); question + feature ask; approval + correction; numbered multi-part replies mirroring the agent's enumeration ("1. … 2. … 4a: …").
→ *The router must **split-and-queue**, not classify whole utterances. Enumeration resolution against the agent's last numbered list is required ("for the first one yes, second one no").*

### F9 — His written style is already transcribed speech

Median message 7–11 words; 30–44% are ≤5 words; ellipsis "…" as prosody in 14–30%; never-corrected typos ("continye", "ok verigy", "putshed", "debauced"). Croatian code-switching in ~5% of Codex messages (agent replies "Gotovo i pushano") and Croatian domain terms embedded in English in urban-stay.
→ *ASR noise is not a new problem — the intent layer must already survive it in text. Fuzzy macro matching is mandatory. Croatian tolerance needed in the STT tier choice.*

### F10 — Status probes and closeout are stereotyped

"anything left?", "what's left?", "are you done? nothing left?", "what's next?" (15× exact in Codex), and the real definition of done: **"commited and pushed?"** (10+ occurrences). Closeout is an explicit act ("mark as done" 21× exact, "ship it", "call it done"), never inferred from a positive test report.
→ *`GET_STATUS` must answer from a read-only snapshot in one breath; `CONFIRM_DONE` stays an explicit human act; commit/push state belongs in the snapshot's first line.*

### F11 — A small closed macro vocabulary covers ~25% of all utterances

"continue", "stop", "mark as done", "ship it", "commit push", "run localhost", "restart", "what's next", "check now", "retry", "unassign me", "clean worktree".
→ *A deterministic phrase→gateway-op table handles a quarter of the traffic with zero model tokens and zero latency. Build it first.*

### F12 — Bounded questions win; open questions get bounced; the question budget is finite

248 AskUserQuestion events: **74% answered with clean option-picks ≤6 words**; 26–37% free-text pushback that amends or rejects the framing ("Yes, but keep Analytics top-level", counter-questions, "I am dioing it in special session. no need here"). Codex ends only ~5% of turns with a question and instead states assumptions with a trailing "If you want…" (7% of finals). Over-questioning triggers explicit frustration: *"I feel a simple redesign admin home page, turned into phyloshofical convo?"* — twice.
→ *Spoken questions: 2–3 options max, always with a recommendation, letters/numbers voice-resolvable. Accept six answer shapes: pick / amendment / counter-question / redirect / defer / "screenshot coming". Budget clarifying questions per task; prefer assume-and-state.*

### F13 — The permission layer has already migrated

90% of sessions run `bypassPermissions`; **zero** tool-permission denials in the whole corpus; ~50% of sessions are fully autonomous (auto-launched, no human present). The only surviving gates: agent-initiated destructive-action confirms (drop stashes, prune branches, restart daemon) and plan approval.
→ *Voice permission UX = spoken destructive confirms + plan approval + "needs you" handoffs. Do not build spoken tool-by-tool permission prompts. And the engine must handle sessions with no human on the floor at all.*

### F14 — Agents already emit speakable narration; completions need 75% compression

Interstitial progress: p50 **19 words**, grammar "*result of last step + next action*" ("Both green. Let me update the docs, then commit.") — speakable verbatim. Turn-final completions: p50 **231 words**, verdict-first openers ("Done" 102×/72×, "Pushed", "Shipped", "Fixed and pushed", "Gotovo i pushano"), 52% contain caveats, 12% end with a "needs you" list. Plans: 1,113–1,326 words of which ~75% (file paths, line numbers, diagrams, tables) is noise aloud.
→ *Spoken completion = verdict + caveats + needs-you + offered next action (~30–60 words). Spoken plan = goal in the user's own words + scope in/out + approach in one sentence + locked decisions/risks + verification method (~60–90 words). Everything else stays visual.*

### F15 — Executors make silent decisions a supervisor should hear

From non-redacted thinking blocks: **assume-and-defer** ("I'll design assuming interactions are local, add sharing later"), **scope inflation** ("probably also check the BE deployment"), **discard-own-work** during merges, **classify-error-as-pre-existing**, **silent error swallowing**.
→ *The snapshot schema includes a `decisions[]` log, and executor system-prompt scaffolding asks agents to externalize exactly these five categories.*

### F16 — A quarter of "user" messages aren't the user

13–26% of user-slot traffic is machinery: auto-launched issue prompts, auto-resume-after-restart injections, task notifications, handoff context blocks.
→ *Human-input provenance must be a typed property of every conversation event. Machine-injected turns can never approve, confirm done, or answer a destructive confirm — this was already a safety principle; the data shows it's also a daily-correctness requirement.*

### F17 — Sessions are long-lived organisms

Codex sessions: median 2 user messages but median **5.3 h wall clock** in the high-traffic sample (max 452 h, i.e. weeks); compaction fired 298 times; turn duration p50 88 s, p90 7.2 min, max 6.1 h. Multi-session coordination talk is real: "the other session already took #122", "wrong chat", "I am dioing it in special session".
→ *Durable conversation state across compaction/restart is not polish, it's table stakes (already a decision). Coop's cross-session role has direct evidence. Turn durations mean the voice layer idles for minutes — the media session must survive silence cheaply.*

---

## North-Star Experience

### Starting from an idea

1. The user describes an unfinished idea naturally.
2. Clay adds useful possibilities, challenges weak assumptions, and asks only the questions that materially change the outcome — **at most a couple, each with 2–3 options and a recommendation** (F12).
3. Clay and the user settle on a concrete plan with acceptance criteria and known caveats.
4. The user approves that exact plan version — possibly **with a spoken amendment that becomes the approved version** (F4).
5. Clay executes without mixing status questions or side conversation into the executor's instruction stream.
6. The user can ask what is happening at any time and receive a one-breath answer from a read-only snapshot (F10, F14).
7. Corrections become explicit changes to intent, tiered: small tweaks steer immediately; material changes produce an intent diff and a re-approval (F5).
8. Clay implements, tests, verifies, reports caveats and needs-you items aloud in ~30–60 words, performs the repository/runtime steps, and asks the user to confirm done. It then **stays hot for "still broken"** (F6).

### Starting from an issue

1. The user reports a symptom — often as "look at this" plus a screenshot from the phone (F7).
2. Clay investigates before prescribing a fix.
3. Clay explains likely root cause, evidence, uncertainty, and confidence in plain language.
4. Clay proposes a repair and verification plan; the user amends and approves by voice.
5. The same execution/status/correction/verification/closeout lifecycle follows, expecting 1–3 verification rounds (F6).

### Working across several sessions

1. The user says, "Coop, what needs me?"
2. Coop summarizes only blocked work, pending decisions, important failures, and meaningful completions.
3. "Get me the one working on X." Coop resolves the target, states which it found, asks once when ambiguous.
4. The user talks to that session, approves a pending decision, or says "Coop, switch to Y."
5. "Go to project A and do Z" routes intent; the exploration → plan → approval discipline still applies in the target session.

The experience should feel like working with capable teammates through a reliable coordinator, not dictating commands into a text box.

---

## Decisions

Product decisions in force (superseded items struck from the v1 list are recorded in the Decision Log):

1. **Conversation mode is first-class.** Composer dictation (`stt.js`) remains a fallback and test harness, not the product model.
2. **Conversation and execution are separate lanes.** The conversational controller may inspect executor state; status questions and discussion never steer active work unless the user sends a revised intent.
3. **Every implementation requires explicit plan approval; amendment is the primary approval flavor.** Approval names a specific plan version. A spoken amendment creates the new version and approves it in one atomic gateway operation. A model may recommend approval but cannot grant it.
4. **Corrections are tiered.** Minor (no change to goal/approach/acceptance criteria) → routed as a steer with zero ceremony. Material → intent diff, new plan version, re-approval. Misclassifying toward the strict side is a product failure mode (users abandon voice), so the classifier defaults minor unless material markers (F5) or scope analysis say otherwise, and every steer is undoable by "stop".
5. **Stop, pause, continue, status, target selection, approval, and closeout are deterministic controls** resolved by a typed gateway, not model improvisation. A ~25%-coverage phrase-macro table (F11) runs before any model sees the utterance.
6. **Barge-in steers; only "stop" stops; stop-speech before stop-work.** (F1)
7. **The daemon is authoritative.** Conversation state survives reloads, daemon restarts, compaction, provider handoffs, and device switches. (F17)
8. **Voice and text share one transcript and lifecycle.** Audio is ephemeral; durable records are transcripts, decisions, plan versions, summaries, outcomes.
9. **Secrets are never spoken.** Redaction happens on the *text* the TTS receives — one reason the pipeline architecture below is mandatory, not optional.
10. **Human-input provenance is typed on every event.** Machine-injected user-slot turns (auto-launch, auto-resume, notifications, handoffs — 13–26% of traffic, F16), synthesized speech, replayed audio, and other agents can never approve, confirm done, or answer destructive confirms.
11. **Zero-marginal-cost core.** The conversational brain runs on existing subscription auth through YOKE; audio I/O runs on free tiers (browser or daemon-local). Paid voice providers are optional adapters. (Owner constraint; see Voice Architecture Decision.)
12. **Pipeline architecture (STT → text controller → TTS), not speech-to-speech.** Decided — see below.
13. **Exactly one client owns the live audio floor**; v1 floor transfer is explicit last-claim-wins with a fenced lease. The full two-phase claim protocol from v1 of this document is **design notes for Phase 3A, to be validated by the instrumented prototype** — Appendix A.
14. **Coop and multi-Mate rooms are separate concepts.** Coop coordinates the workspace; a room moderates participants inside one task.
15. **Android is a hardware companion, not a second Clay application.**
16. **Shared conversation does not force shared navigation.** Workspace conversational focus is durable and shared; each client browses independently.
17. **Multiplayer scope (v1):** the audio floor and conversation lifecycle are scoped per-user. Two teammates conversing simultaneously with the same session is explicitly out of scope until after Phase 3B; their text/steer paths continue to work as today.

---

## Voice Architecture Decision: Pipeline, Not Speech-to-Speech

Two possible architectures existed:

**(A) Speech-to-speech** — OpenAI Realtime (gpt-realtime-2) as both ears and brain. Best latency and turn-taking. Rejected, on three independent grounds:

1. **Cost/subscription**: ChatGPT Pro does **not** include OpenAI API access; Realtime is separate pay-per-use at $32/$64 per M audio tokens ≈ **$0.10–0.45/min** in practice (~$0.05–0.10/min with aggressive caching). An all-day ambient session is $20–80/day of new spend. Violates Decision 11 outright.
2. **Redaction**: "secrets are never spoken" is only enforceable if there is a *text* artifact between the brain and the speaker. A speech-to-speech model's audio output cannot be reliably redacted or tested against secret fixtures. Violates Decision 9.
3. **Brain quality/coherence**: the conversational brain would be a different vendor's voice-tuned model reasoning about Claude's plans and snapshots, with no access to Clay's session context, memory, or permission system.

**(B) Pipeline** — streaming STT → text conversational controller → streaming TTS. Chosen. Latency is worse (target: first spoken syllable ≤ 1.5 s after end-of-turn; acceptable because the user's real interaction rhythm is turn-boundary, not rapid-fire — F1), but every constraint is satisfied, and the controller becomes a first-class Clay citizen:

### The conversational controller is a YOKE session on subscription auth

The controller is **not** a new metered API client. It is a lightweight background session driven through the exact same machinery that runs coding sessions today:

- Spawned via `yoke` (Claude adapter) with the user's existing **Claude Team subscription OAuth** — the same auth path `lib/yoke/index.js` already resolves when `ANTHROPIC_API_KEY` is absent. Zero new credentials, zero marginal dollars; it draws from subscription usage windows.
- Precedent already in the codebase: `sdk-bridge-mentions.js` maintains *persistent read-only @mention query sessions* — the controller is architecturally the same animal with a different system prompt and toolset.
- **Toolset**: read-only. It can read the conversation ledger, plan versions, executor snapshots, and (bounded) session transcript/files. Its only write path is *proposing typed gateway operations* (structured output), which the daemon validates and executes. It can never edit files or talk to the executor directly.
- **Vendor-portable**: because it goes through YOKE, the controller can alternatively run on the Codex adapter (ChatGPT Pro auth) — useful when Claude usage windows are exhausted. The controller contract is adapter-neutral.
- **Usage-window discipline** (it burns subscription quota, so): system prompt frozen and cache-friendly; snapshots delivered as compact structured text; deterministic macro layer (F11) answers ~25% of utterances with zero controller tokens; `GET_STATUS` answered by template from the snapshot (zero tokens) unless the user asks a *why* question; controller turns targeted at &lt; 500 output tokens.

### Audio I/O: a three-tier ladder behind one adapter interface

One provider-neutral interface (`stt-adapter` / `tts-adapter` contracts, negotiated per client+daemon capability), three tiers:

| Tier | STT | TTS | Cost | Latency | Notes |
|---|---|---|---|---|---|
| **0 — Browser** (first slice) | Web Speech API — already integrated in `lib/public/modules/stt.js` (continuous + interim, 7 languages) | `speechSynthesis` — built into every browser incl. iOS Safari PWA | **$0** | STT good on Chrome; TTS instant | Chrome-quality recognition; degrades on Firefox/Brave; fine to prove the whole kernel |
| **1 — Daemon-local** (Phase 2) | whisper.cpp / faster-whisper on the daemon host (realtime+ on Apple Silicon; multilingual incl. Croatian — F9) | Kokoro (open-weights, near-commercial quality, realtime on M-series) or Piper; macOS `say` as trivial fallback | **$0** | ~300–800 ms STT finalize; ~100–300 ms TTS first audio | Private (audio never leaves the machine); serves **all clients incl. phone** via daemon-mediated audio over the existing WS; this is the workhorse tier |
| **2 — Paid cloud** (optional, never required) | Deepgram Flux (~$0.46/hr streaming, built-in end-of-turn detection) or OpenAI realtime transcription (~$0.46/hr) | Cartesia Sonic (~90 ms TTFA, $50/M chars) / Deepgram Aura ($15/M chars) / ElevenLabs ($66/M chars) | ~$0.50–1.00/hr active | best-in-class | Pluggable adapter; config per user; off by default |

End-of-turn detection: Tier 0 uses Web Speech finalization + a configurable silence timer + push-to-talk override; Tier 1 adds local VAD (e.g. Silero) in front of whisper; Tier 2 (Flux) has it natively. Barge-in at every tier = duck-and-cancel local playback (client-side, instant) + queue the transcript as a steer (F1).

### Cost model (for the record)

| Path | Marginal cost of a 6 h working day |
|---|---|
| Chosen: Tier 0/1 audio + subscription controller | **$0** (subscription usage windows only) |
| Tier 2 audio + subscription controller | ~$3–6 |
| Rejected: OpenAI Realtime speech-to-speech | ~$20–80 |
| Reference: controller on metered API instead of subscription (Haiku 4.5 $1/$5 per MTok, cache reads 0.1×) | ~$0.50–2 — the fallback if subscription windows ever become the bottleneck |

---

## Product Surfaces

### 1. Session Conversation Controller
Owns the lifecycle for one work session: explore/diagnose, record the approved plan, supervise execution, answer status from snapshots, route corrections by tier, manage closeout. Implemented as the YOKE background session described above plus the daemon-side kernel modules (see Implementation Map).

### 2. Executor Lane
Claude, Codex, or Copilot performs approved work — exactly today's sessions. It receives approved intent, tiered corrections (minor = steer via the existing `steerInterruptRequested` path in `project-user-message.js`/`sdk-bridge-stream.js`; material = new approved intent), deterministic controls, and explicit answers. Provider events are normalized into the shared snapshot near the YOKE adapters.

### 3. Coop Workspace Coordinator
Above projects and sessions: resolve, triage, narrate, focus, route. Runs on a persistent daemon-level coordination channel independent of the per-project WebSocket (which is replaced on project switch). Reuses `server-palette.js` cross-project search as a resolution input.

### 4. Cross-Device Conversation Continuity
Web, PWA, and native clients are equal views of one durable conversation. Any client can claim the audio floor via an explicit **Continue here** gesture; v1 is last-claim-wins with a fenced lease epoch (stale frames dropped). Full handoff protocol: Appendix A, gated on the Phase 3A prototype.

### 5. Minimal Android Companion
Native mic capture, playback, audio focus, Bluetooth routing, foreground service, lock-screen/notification controls. Built only after the browser proof identifies concrete failures. Unchanged from v1 (see Phase 4).

### 6. Multi-Mate Conversation Room
Later collaboration mode; moderator owns the audible floor. Unchanged from v1 (Phase 5).

---

## Core Architecture

```text
                              Clay daemon
┌────────────────────────────────────────────────────────────────────────┐
│                                                                        │
│  Persistent coordination channel (daemon-level, project-independent)   │
│      │                                                                 │
│      ├── Coop coordinator ── target resolver (server-palette) / triage │
│      │                                                                 │
│      └── Session Conversation Controller                               │
│              │                                                         │
│              ├── deterministic intent router (macro table → splitter)  │
│              ├── controller brain = YOKE background session            │
│              │     (Claude Team subscription auth, read-only tools,    │
│              │      structured-output proposals only)                  │
│              ├── conversation ledger (plans, approvals, diffs, done)   │
│              ├── typed control gateway (validates + executes ops)      │
│              └── normalized executor snapshot (read-only)              │
│                              │                                         │
│                              v                                         │
│              Executor session (Claude / Codex / Copilot via YOKE)      │
│                                                                        │
│  Voice layer:  stt-adapter ⇄ media WS frames ⇄ tts-adapter             │
│    Tier 0 runs in-browser; Tier 1 runs here (whisper.cpp + Kokoro);    │
│    Tier 2 is an outbound cloud adapter. Redaction sits between the     │
│    controller's text output and every TTS adapter.                     │
└────────────────────────────────────────────────────────────────────────┘
        ▲ control, transcript, state            ▲ media frames (Tier 1/2)
        │                                       │
  Desktop / PWA clients                  Phone browser / Android companion
```

The explicit action flow:

```text
mic audio → STT tier → confirmed transcript (provenance: live-human, device, floor epoch)
  → deterministic macro table (~25% resolved here: NUDGE, STOP, GET_STATUS, ops verbs)
  → utterance splitter (multi-intent → ordered intent list, enumeration resolution)
  → controller brain (classification + response + proposed typed operations)
  → daemon policy + deterministic gateway (validate provenance, plan version, target)
  → executor lane / ledger transition / spoken reply (redact → TTS tier → floor owner)
```

Single-device media may be client-local (Tier 0) or daemon-mediated (Tier 1/2). Cross-device handoff always uses daemon-mediated media so input and output fencing is enforceable. Control state, authorization, session identity, and durable decisions always flow through the daemon.

---

## Independent State Models

Six state machines stay independent so the UI and speech layer can tell the truth (unchanged from v1, refined):

**Media**: `idle → listening → transcribing → speaking`, with `reconnecting / interrupted / failed`. Note F17: `idle-while-executor-works` is the *dominant* media state — the loop must idle for many minutes at zero cost.

**Work lifecycle**: `exploration|diagnosis → proposed-plan → approved-plan → executing → verifying → closeout → complete`, with `blocked`. Post-`complete` re-entry ("still broken", F6) transitions back to `diagnosis` with full context retained — model it as `REOPEN_WORK`, first-class and cheap.

**Executor**: `idle / working / waiting-for-input / paused / stopped / failed / completed` (derived from YOKE events; see Snapshot).

**Workspace conversational focus**: `Coop / project / session / none` — the shared target of speech; not the page any client displays.

**Client visual focus**: per-client, independent; a Coop switch changes a client's view only when accepted.

**Audio floor**: `unclaimed / active(client, device, user, epoch)` — v1 semantics: explicit claim, last-claim-wins, monotone epoch fencing, floor returns to `unclaimed` on owner loss or daemon restart (new generation invalidates all leases). Extended claim-transaction states: Appendix A.

---

## Intent Router (data-grounded)

Three stages, cheapest first:

### Stage 1 — Deterministic macro table (no tokens, &lt;10 ms)

Fuzzy-matched (edit distance ≤ 2 per word, F9) closed vocabulary → gateway ops. Covers ~25% of real traffic (F11):

| Utterance family | Op |
|---|---|
| "continue", "continye", "keep going", "retry" | `NUDGE` (auto-continue / poke stalled turn) |
| "stop" (bare) | `STOP_SPEECH`; if nothing is being spoken → confirm "stop the work too?" (reversible-first, F1) |
| "stop the work", "kill it" | `STOP_WORK` |
| "what's next", "anything left", "are you done", "status" | `GET_STATUS` (template answer from snapshot, zero tokens) |
| "commited and pushed?", "commit push", "commit and push" | `GET_STATUS(git)` / ops dispatch |
| "mark as done", "ship it", "call it done" | `CONFIRM_DONE` (requires live-human provenance) |
| "run localhost", "restart", "restart the daemon" | ops dispatch (existing task/loop plumbing) |
| "wrong chat", "wrong session" | focus correction — offer last-focused alternatives |
| bare "yes"/"ok"/"do it"/"1"/"a"/"num 3" **when a proposal or enumeration is pending** | approval resolution (Stage 1.5 below) |

### Stage 1.5 — Approval & enumeration resolver

Maintains the *last agent enumeration* (options, plan version, question set). Resolves option tokens, partial approvals ("1 yes, 2 not needed"), and detects riders: any non-approval remainder after the approval phrase is re-fed to Stage 2 as an additional intent ("yes, and commit and push" → `APPROVE_PLAN_VERSION` + ops dispatch; "Yes, but keep Analytics top-level" → `APPROVE_WITH_AMENDMENT`). Low-confidence transcript + approval intent → one-line read-back before the gateway accepts (spoken approvals of plan versions always read back the version's one-line goal).

### Stage 2 — Utterance splitter + classifier (controller brain)

Everything else goes to the controller session with the current enumeration, lifecycle phase, and snapshot header in context. Its structured output is a list:

```json
{
  "intents": [
    {"kind": "bug_report", "text": "...", "needs_visual": true},
    {"kind": "correction", "tier": "minor|material", "markers": ["you missed the point"]},
    {"kind": "question_back", "text": "..."},
    {"kind": "approval", "scope": "partial", "items": {"1": "approve", "2": "reject"}},
    {"kind": "ops", "op": "COMMIT_PUSH"}
  ],
  "reply": "spoken response text",
  "proposed_ops": [{"op": "STEER_EXECUTOR", "payload": "..."}]
}
```

Classifier kinds mirror the empirical taxonomy (F-table): `new_task, exploration, plan_feedback, approval, correction_minor, correction_material, status, bug_report, test_report, info_supply, question, ops, closeout, stop, context_switch, coordination` (multi-session talk → Coop hook), plus `defer` and `screenshot_pending` (F7, F12).

### Correction routing (Decision 4)

`correction_minor` → `STEER_EXECUTOR` immediately (maps onto the existing steer path: `payload.steer`, `steerInterruptRequested`, abort+auto-resume in `sdk-bridge-stream.js`) and is narrated in one line ("Steering: smaller icon."). `correction_material` (markers from F5, or the diff touches goal/approach/acceptance criteria) → controller produces the correction diff (what changed / affected work / changed criteria / plan still valid? / recommendation), speaks it in ≤ 3 sentences, and awaits `APPROVE_WITH_AMENDMENT`. When the classifier is unsure it asks *one* bounded question ("Small tweak or does this change the plan?") — and remembers the answer as a labeled example (per-user tuning corpus).

---

## Two-Lane Conversation Model

### Conversation lane may
Explore, challenge, explain; read plan versions, decisions, snapshots; summarize status/caveats; propose plans/corrections/actions; ask for approval of a specific version; resolve Coop targets and switch focus.

### Executor lane receives only
An approved plan version; an approved intent change; a minor-tier steer; deterministic pause/continue/stop/permission answers; explicit information the executor requested.

A status question must never enter the executor input queue (Invariant 2). "What are you doing?" reads a snapshot. "Stop" invokes the gateway. "Change the button to blue instead" is a minor steer; "actually we did B2B receipts not eRacun" is a material correction with a diff and re-approval.

### Normalized executor snapshot (schema)

Derived near the YOKE adapters (`claude-events.js` / `codex-events.js` flatten provider events; a new `conversation-snapshot.js` reduces them). Persisted (survives reload/restart, F17); never contains raw chain-of-thought.

```json
{
  "project": "clay", "sessionId": "…", "provider": "claude",
  "title": "Voice conversation roadmap",
  "lifecycle": "executing",
  "executor": "working",
  "currentStep": "Both green. Updating docs, then commit.",
  "lastTransition": {"kind": "tests_pass", "at": "…"},
  "taskList": [{"subject": "Bound Guesty request time", "status": "completed"}],
  "planVersion": {"id": "pv_7", "goal": "one-line goal in user's words", "approvedBy": "bojan", "at": "…"},
  "acceptanceCriteria": ["…"],
  "pending": {"kind": "question|permission|needs_you|none", "items": [], "enumeration": ["A …", "B …"]},
  "needsYou": ["paste the Guesty reservation URL"],
  "verification": {"testsRun": ["lint", "build"], "lastResult": "pass", "smokeUrl": null},
  "git": {"committed": true, "pushed": true, "branch": "bojan"},
  "decisions": [
    {"kind": "assume_and_defer", "text": "designed assuming receiver interactions are local"},
    {"kind": "error_preexisting", "text": "TS errors judged pre-merge"}
  ],
  "errors": [], "blockers": [], "caveats": ["daemon restart required to take effect"],
  "confidence": "high",
  "updatedAt": "…", "maybeStale": false
}
```

Field choices trace to data: `currentStep` = the p50-19-word narration (speakable verbatim, F14); `needsYou` = the 12%-of-reports blocker channel (F14); `git` first-class because commit/push is his definition of done (F10); `pending.enumeration` powers option-token resolution (F3/F12); `decisions[]` = the silent-decision categories (F15); executor scaffolding (a system-prompt addendum injected via YOKE instruction merging) asks agents to emit those five categories explicitly.

---

## Plans, Decisions, and Corrections

### Intent commits
A durable product record (not a Git commit): goal in the user's own words; selected approach and rejected material alternatives; acceptance criteria; constraints and caveats; plan version + approval identity/provenance/time; links to the executing session and resulting work.

### Approval semantics
- Approval references an immutable plan version. Editing → new version, prior approval invalidated.
- **`APPROVE_WITH_AMENDMENT` is first-class**: one utterance both revises and approves; the gateway creates the version, records the amendment text, and approves atomically, then the controller confirms the amendment aloud in one line. (F4 — the only approval flavor observed in the wild.)
- Fused approval+dispatch ("yes, and push") approves and queues the ops command in order.
- Approval binds verified live-human provenance (F16), immutable project/session ID, and the exact version. Low-confidence recognition or ambiguous version → one-line read-back first.
- "sounds reasonable", "makes sense" = conversational agreement, **not** approval. The detector is the F3 phrase set + option tokens, not sentiment.
- Synthesized speech, replayed audio, another agent, or machine-injected text can never approve.

### Pre-approval mutation boundary
Before approval: converse, inspect, search, read-only investigation, non-mutating repro, plan drafting. Not allowed: file edits, repo/runtime mutation, executor instructions, external actions. The approved plan authorizes only what it names; goal/approach/constraints/criteria changes require a new version. Destructive/deploy/publish/merge/external actions keep their own confirms (F13: these are the only gates the user actually still uses — make them crisp spoken confirms with the consequence stated: "Dropping 3 stashes is unrecoverable — drop them?").

### Correction diffs
On material correction, state: what changed; which completed/active work is affected; which acceptance criteria changed; whether the plan remains valid; recommendation. Spoken in ≤ 3 sentences; full diff visual.

### Closeout
Executor "done" → `verifying`/`closeout`, never `complete` (Invariant 8). Verification prefers **agent-driven proof** (run lint/build/smoke, read the result aloud — the Codex "Verified:" format, F6/F14) so the user's own testing round shrinks. Only live-human `CONFIRM_DONE` ("mark as done", "ship it") completes. `REOPEN_WORK` re-enters with history intact and is expected traffic, not an edge case.

---

## Deterministic Control Gateway

Typed operations; each carries target, idempotency key, authorization context (incl. provenance class), and result. Only gateway ops change authoritative state.

`STOP_SPEECH` · `STOP_WORK` · `PAUSE` · `CONTINUE` · `NUDGE` · `GET_STATUS` · `STEER_EXECUTOR` · `FOCUS_TARGET` · `APPROVE_PLAN_VERSION` · `APPROVE_WITH_AMENDMENT` · `REJECT_PLAN_VERSION` · `REQUEST_PLAN_REVISION` · `SEND_APPROVED_INTENT` · `ANSWER_PERMISSION` · `ANSWER_QUESTION` · `CONFIRM_DONE` · `REOPEN_WORK` · `END_CONVERSATION` · `CLAIM_AUDIO_FLOOR` · `RELEASE_AUDIO_FLOOR`

Rules: "stop talking" ≠ "stop the work"; ambiguous "stop" silences speech immediately (reversible) then asks. `ANSWER_PERMISSION` binds the exact pending request ID and expires with it. `NUDGE` and `GET_STATUS` are rate-limit-free and never enter the executor queue. Every op is idempotent under reconnect/replay.

---

## Spoken Response Policy (data-grounded)

- **Speak**: conclusions, bounded questions (2–3 options + recommendation), decisions, plan summaries, state *transitions* (tests pass/fail, push done, retry, unexpected discovery), blockers/needs-you, caveats, destructive confirms.
- **Don't speak**: logs, tool calls, file paths, line numbers, diffs, per-edit narration, token-by-token anything, secrets (redaction layer is mandatory and test-gated), routine progress.
- **Completion utterance** = verdict word first, then caveats, then needs-you, then offered next action; 30–60 words (F14). Then stay hot for "still broken" (F6).
- **Status utterance** = one breath from the snapshot: lifecycle + currentStep + needsYou + git state. Template-generated (zero tokens); the brain engages only for *why* questions.
- **Plan narration** = goal (user's own words) → in/out of scope → approach in one sentence → locked decisions/risks → verification method; 60–90 words; full plan stays visual (F14: ~75% of plan text is noise aloud).
- **Proactive progress**: during long turns (p90 = 7 min, F17), a short spoken pulse at meaningful transitions only — calibrated to preempt "alive?" checks without narrating routine steps. User-configurable cadence, server-side setting.
- **Question budget**: default ≤ 2 clarifying questions per task before the controller must assume-and-state ("Codex-style": act on the stated assumption, offer "If you want…" alternatives). Over-budget asks require the user to have opted into "interview me" mode (e.g. spec/interview skills). (F12 — "too philosophical" is a product failure signal.)
- **Long content**: appears in the transcript with a spoken offer to summarize aloud.
- Accessibility: every audio-only state has a visual equivalent; text input and controls remain available at all times.

---

## Persistence, Privacy, Recovery

**Durable**: conversation lifecycle + focus; confirmed transcripts (with provenance class per event); intent commits, decisions, plan versions, approvals, amendments; normalized snapshots + attention events; device registrations (human-readable names, revocable) + route preferences; closeout summaries. Storage: JSONL per conversation under `~/.clay/conversations/<project>/<sessionId>.jsonl`, same append-only + replay conventions as session storage.

**Ephemeral**: raw mic audio; synthesized audio buffers; provisional transcript fragments after finalization; voice-provider credentials.

**Protections**: always display the active mic, floor owner, and device name; state where media is processed (on-device / daemon / third party — Tier 0 sends audio to the browser vendor, Tier 1 stays local, Tier 2 goes to the configured provider); never speak secrets/credentials/env values/unredacted logs (redaction runs on controller text before TTS; secret fixtures test-gated); server-side settings only (no localStorage); revocable auditable device registrations; idempotent controls; restart recovery without duplicating the last utterance or executor instruction (existing recovery canaries must stay quiet — see Reliability Baseline).

---

## Implementation Map (module-level)

Per `MODULE_MAP.md` conventions: `attachXxx(ctx)`, ≤ 500 lines/module, no inline logic in `project.js` handleMessage, client state in store slices + `ws-ref.js`, `var`/no-arrow-functions server-side CommonJS, client ES modules.

### Server (lib/)

| Module | Concern |
|---|---|
| `conversation-kernel.js` | Lifecycle reducer (six state machines), conversation ledger persistence, replay |
| `conversation-gateway.js` | Typed ops: validation, provenance checks, idempotency, dispatch to executor/ledger |
| `conversation-router.js` | Stage 1 macro table + fuzzy matcher + approval/enumeration resolver (Stage 1.5) |
| `conversation-controller.js` | Controller brain: spawns/maintains the YOKE background session (mention-session pattern), builds compact context (snapshot header + enumeration + last turns), parses structured proposals |
| `conversation-snapshot.js` | Reduces YOKE adapter events into the snapshot schema; persistence; staleness marking |
| `conversation-scaffold.js` | Executor system-prompt addendum (externalize the five silent-decision categories, needs-you list, verification report format) injected via YOKE instruction merge |
| `conversation-redaction.js` | Never-speak policy: secret patterns, env values, credential shapes; test fixtures |
| `conversation-narration.js` | Template speech: status/completion/plan compression per the Spoken Response Policy |
| `conversation-media.js` | Media WS frames (Tier 1/2): mic frame ingest with epoch fencing, TTS chunk egress, floor lease state |
| `voice-adapters/stt-local.js`, `voice-adapters/tts-local.js` | Tier 1: whisper.cpp / Kokoro child processes (worker-forked, off the daemon event loop like `task-source-worker.js`) |
| `voice-adapters/stt-cloud.js`, `voice-adapters/tts-cloud.js` | Tier 2 optional adapters behind the same contract |
| `server-coordination.js` | Persistent daemon-level WS channel (presence, focus, claim state, attention events, Coop routing) — a new focused module, **not** an extension of `server-global-ws.js` |
| `coop-resolver.js`, `coop-attention.js`, `coop-narrator.js` (Phase 3B) | Target resolution (reusing `server-palette.js` BM25 + recency), attention queue, cross-session narration |

Message routing: new `conversation_*` / `voice_*` / `coord_*` WS types registered in `ws-schema.js`, dispatched from `project-message-router.js` (session-scoped) and the coordination channel (workspace-scoped). Executor steering reuses `project-user-message.js` `dispatchPreparedToSdk` steer path unchanged.

### Client (lib/public/modules/)

| Module | Concern |
|---|---|
| `convo-store.js` | Store slice: media state, floor state, lifecycle, transcript, pending enumeration |
| `convo-mic.js` | Capture: Tier 0 Web Speech wrapper (shares permission UX with `stt.js`) or getUserMedia→WS frames for Tier 1/2; VAD hooks; push-to-talk |
| `convo-speaker.js` | Playback: `speechSynthesis` (Tier 0) or streamed audio chunks; barge-in duck/cancel; epoch-checked playback |
| `convo-ui.js` | Conversation mode UI: floor indicator ("Listening · Working"), live transcript with provisional/confirmed styling, Continue-here button, stop-speech vs stop-work controls |
| `convo-transcript.js` | Rendering the shared transcript + plan cards / approval read-backs into the message stream (reuses `tools-plan.js` plan cards) |

`stt.js` remains untouched as composer dictation. No `localStorage`; voice settings (tier, voice, progress cadence, question budget) go server-side via the settings plumbing.

---

## Reliability Baseline (precondition)

Existing stalls, phantom reconnects, resume spam, and UI lag are conversation-correctness risks — a voice loop amplifies every one of them into a user-facing failure ("did you stop again?" is already 11% of typed traffic, F2). Before Phase 1 exits: run the documented diagnostics (`docs/guides/DIAGNOSTICS.md`), record a quiet baseline in `~/.clay/recovery-events-dev.log` / `diag-dev.log`, and gate every phase exit on the canaries staying quiet.

---

## Delivery Phases

### Phase 0 — Contract, scoped to the first slice

Lock semantics before UI/media detail, but only what the slice needs:

- [ ] Typed events for: control ops (list above), lifecycle transitions, intent commits, snapshot, provenance classes, media frames, floor lease (v1 semantics).
- [ ] Idempotency, sequencing, reconnect/replay behavior; provenance rules (F16).
- [ ] Snapshot schema (above) + adapter mapping tables for Claude and Codex events.
- [ ] Macro table v1 + approval phrase set (seeded from Appendix B phrase inventory).
- [ ] Redaction policy + never-speak test fixtures.
- [ ] Minimal persistent coordination channel spec (presence, floor state, claim offers) — spec only; implementation lands in Phase 3A.
- [ ] Timing instrumentation points (mic start, transcript, route, brain, gateway, TTS-first-audio, floor ops).
- [ ] Reliability baseline recorded.

**Exit**: the same simulated conversation runs through text and scripted-voice event fixtures without changing lifecycle semantics. *(Full 15-op gateway, claim transaction states, and Coop events are explicitly deferred.)*

### Phase 1 — Vertical slice: thin kernel + Tier 0 voice (desktop Chrome)

The inversion from v1 of this doc: voice is in the *first* slice, kernel depth follows evidence.

- [ ] Thin kernel: lifecycle enum + ledger persistence + gateway with `STOP_SPEECH/STOP_WORK/NUDGE/GET_STATUS/STEER_EXECUTOR/APPROVE_PLAN_VERSION/APPROVE_WITH_AMENDMENT/CONFIRM_DONE/REOPEN_WORK`.
- [ ] Stage 1 macro router + enumeration/approval resolver.
- [ ] Controller brain as YOKE background session (subscription auth), read-only tools, structured proposals.
- [ ] Snapshot v1 for the Claude adapter (Codex next phase); executor scaffold addendum.
- [ ] Tier 0 audio: Web Speech capture + `speechSynthesis` output, silence-timer end-of-turn + push-to-talk, barge-in = duck + queue-steer.
- [ ] Spoken plan review + amendment approval; spoken status from snapshot; spoken completion (verdict/caveats/needs-you); minor-steer path; correction-tier classifier v1.
- [ ] Redaction live on the TTS path; text composer remains a parallel input throughout.
- [ ] One project, one executor session, one client. Measure everything.

**Exit**: both north-star workflows (idea + issue) complete on a real task by conversation in desktop Chrome — explore, amend-approve, supervise with non-interrupting status, minor + material corrections, verification, spoken closeout, "still broken" re-entry — with canaries quiet. **This phase is also the evidence gate for kernel depth**: what conversation actually needs determines which v1-spec machinery gets built out next.

### Phase 2 — Tier 1 audio + kernel hardening

- [ ] Daemon-local STT/TTS workers (whisper.cpp/faster-whisper + Kokoro/Piper), local VAD, adapter contract + capability negotiation between tiers.
- [ ] Daemon-mediated media frames over WS (this is also the substrate Phase 3A needs).
- [ ] Codex snapshot adapter; provider handoff continuity for the conversation ledger.
- [ ] Correction-tier classifier tuning from Phase 1 labeled examples; question-budget enforcement; proactive progress pulses.
- [ ] Croatian/mixed-language STT validation (F9).
- [ ] Restart/compaction recovery exercises; intent-commit history UI.

**Exit**: the daily loop runs all day on Tier 1 at $0 marginal cost, private, with the phone browser usable as a *stationary* second client (no live handoff yet).

### Phase 3A — Cross-device continuity (browser proof)

- [ ] Persistent coordination channel implementation (presence, device names server-side, floor state fan-out).
- [ ] **Continue here** explicit claim; v1 floor semantics (last-claim-wins, epoch fencing, unclaimed-on-loss, generation invalidation on restart).
- [ ] Instrumented two-client prototype: desktop Chrome ⇄ Android Chrome/PWA, measuring claim latency, audio resume, suspension/lock/network-handoff behavior, accidental-claim rate.
- [ ] **Evidence gate**: only after measurement, adopt lease budgets and the speech-resume policy, and decide how much of the Appendix A protocol (two-phase claim, break-before-make output, playback-offset resume) reality requires.

**Exit**: start on the laptop, claim on the phone, continue the same conversation, return — without losing state, duplicating a turn, or echo; measured numbers recorded here.

### Phase 3B — Coop (parallel with 3A after Phase 2)

- [ ] Coordination channel extensions: target resolution (server-palette inputs + recency + pending decisions), immutable target bindings revalidated at dispatch, attention queue (permissions, blocked, failures, completions awaiting closeout, stale sessions).
- [ ] Focus/switch commands for connected clients; workspace-level Coop ledger; explicit-ambiguity questions ("I found 'Voice roadmap' in clay, session 14 — switch?").
- [ ] The user's real coordination vocabulary as seed grammar: "what needs me", "get me the one working on X", "the other session already took #122", "wrong chat" (F17).
- [ ] Test stale/missing/completed/duplicate/permission-denied targets. Bulk commands deferred.

**Exit**: find a session by topic, act on its pending decision, switch projects, start a new task — hands-free.

### Phase 4 — Minimal native Android companion

Unchanged from v1 in shape; entry gate = concrete measured browser failures in background/screen-off operation, mic/playback suspension, Bluetooth/audio focus, headset/lock-screen controls, or lifecycle recovery. Kotlin/Compose, not a WebView shell; sign-in + device registration, conversation/status screen, PTT + mode + mute + stop controls, foreground service + media session, deep links into the web UI. Exit criteria as v1 (claim/return floor, survive background+lock, call interruption recovery, same gateway, no silent recording).

### Phase 5 — Rooms and advanced orchestration

Multi-Mate fan-out with moderated floor; Coop subscriptions ("tell me when either reaches a decision"); LiveKit or similar evaluated only from measured needs; iOS from demand.

---

## Acceptance Journeys

1. **Fresh idea** — explore, challenge, plan, amend-approve, implement, status, verify, close.
2. **Reported issue** — diagnose, explain evidence/confidence, plan, approve, repair, verify, close.
3. **Non-interrupting status** — status during execution changes nothing in the executor queue (executor transcript byte-identical with and without the question).
4. **Minor correction** — "make the icon smaller" steers within seconds, no ceremony, narrated in one line.
5. **Material correction** — "you missed the point, the flow is…" produces a spoken diff and re-approval; only invalidated work redone.
6. **Still-broken re-entry** — after a done *report*, "didn't work" re-enters diagnosis with context hot; after `CONFIRM_DONE`, `REOPEN_WORK` does the same.
7. **Restart recovery** — browser and daemon restarts resume the same lifecycle, plan version, and floor state (floor re-claimed explicitly).
8. **Cross-device continuation** — begin on web, Continue-here on phone, return.
9. **Coop navigation** — find by topic, disambiguate once, act on a pending decision.
10. **Closeout** — verification evidence spoken, caveats stated, explicit "mark as done".

---

## Metrics

Percentiles and failure rates, not averages.

| Metric | Starts | Ends | Target (Tier 1) |
|---|---|---|---|
| Listening startup | activation | mic accepting audio | &lt; 500 ms |
| Partial transcript | word spoken | word visible | &lt; 800 ms |
| Turn finalization | user stops | confirmed intent | &lt; 1.2 s |
| Macro-path response | confirmed intent | op executed / speech starts | &lt; 300 ms |
| Brain-path response | confirmed intent | first spoken syllable | &lt; 2.5 s |
| Status response | ask | snapshot summary begins | &lt; 1 s |
| Speech interruption | barge-in/stop | silence | &lt; 150 ms |
| Work control | pause/stop/continue | executor acknowledges | &lt; 1 s |
| Device claim | Continue-here | active + old client silent | &lt; 3 s |
| Recovery | connection usable | durable state restored | &lt; 2 s |

Quality: approval correctness (no unapproved version executes — zero tolerance); correction-tier misclassification rate (both directions; strict-side errors weighted heavier); status fidelity vs executor events; false turn-endings; echo loops; duplicate sends; secret-redaction failures (zero); hands-free completion rate per journey; **subscription usage burn** (controller tokens/day, share of usage window — budget alert at configurable %); presence-check rate ("alive?" utterances should trend to zero as proactive progress lands, F2).

---

## Executable Safety Invariants

Release-blocking automated tests:

1. No executor input, file/repo/runtime mutation, or state-changing external action without a valid approval bound to the current immutable plan version and target.
2. A status request produces zero executor-input events.
3. An approved plan version begins execution at most once.
4. Reconnect, replay, and duplicate delivery cannot repeat an approval, control, permission answer, or intent dispatch.
5. A changed, stale, missing, or ambiguous Coop target receives no routed action; changing visual focus cannot retarget an in-flight utterance.
6. A permission/question answer applies only to its exact still-pending request ID.
7. Executor completion cannot mark lifecycle `complete`; only verified live-human `CONFIRM_DONE` can.
8. Machine-injected user-slot events (auto-launch, auto-resume, notifications, handoffs), synthesized speech, replayed audio, and agent-generated text can never approve, confirm done, or answer a destructive confirm (F16).
9. A minor-tier steer never alters plan version, goal, approach, or acceptance criteria records; a material correction cannot execute under the previous approval.
10. Only input frames carrying the current floor lease epoch are accepted; every pre-restart lease is rejected under a new daemon generation; loss of the owner returns the floor to `unclaimed`, never silently migrating it.
11. Opening, focusing, unlocking, or reconnecting a client cannot claim the floor.
12. Voice-provider failure leaves executor work intact and immediately exposes text transcript and deterministic controls.
13. Secret fixtures never appear in synthesized speech, narration text, retained transcripts, or diagnostics.
14. Amendment approval records both the amendment text and the resulting version; the executed plan is byte-identical to the approved version.

(The v1 list's audio-handoff invariants 10–19 become Phase 3A acceptance criteria — Appendix A.)

---

## Testing Matrix

**Lifecycle**: exploration, diagnosis, plan revision, amendment-approval, execution, verification, closeout; status while working; correction before/during/after work; still-broken re-entry ×3 rounds (F6); permission question while another session completes; reload, daemon restart, compaction, provider handoff, stale snapshots.

**Router** (fixtures drawn from the mined corpora — Appendix B): every macro phrase incl. typo variants ("continye", "ok verigy", "commit push"); fused approvals ("yes, and commit and push"); partial approvals ("1 yes, 2 not needed"); guarded approvals ("ok try it but don't commit untill I'm happy"); amendment approvals ("Yes, but keep Analytics top-level"); material markers ("you missunderstood", "like I said", "no no no"); multi-intent chains (3-bug utterance); enumeration answers ("for the first one yes"); counter-questions; deferrals ("doing it in another session"); "screenshot coming"; Croatian fragments; conversational-agreement-that-is-not-approval ("sounds reasonable").

**Coop and routing**: exact/similar/missing/completed/deleted targets; same title across projects; permission-denied target; state change during resolution; rapid focus changes; command spoken during a switch; multiple simultaneous pending decisions.

**Clients and audio**: desktop Chrome, Android Chrome, installed PWA, (later) native companion; laptop/phone mic-speaker combinations; wired + Bluetooth; route changes while listening/speaking; barge-in during TTS; silence for 30+ minutes then resume; suspension/lock/network handoff/incoming call; daemon restart + stale pre-restart frames + fresh claim; simultaneous claims; provider timeout and fallback to text.

**Safety**: approval-resembling speech that isn't approval; agent-generated audio attempting approval; secrets in logs/env/transcripts/snapshots; replayed control messages; old-client audio after handoff; device-credential revocation; stop-speech vs stop-work ambiguity; machine-injected turns attempting gateway ops.

---

## Non-Goals

- Rebuilding Clay screens as a native Android application
- Treating composer speech-to-text as conversation mode
- Running Claude Code or Codex on the phone
- **Requiring any paid voice API for the core experience** (Tier 2 is optional)
- **Speech-to-speech as the foundation** (rejected — cost, redaction, brain quality)
- Multiple agents or clients speaking simultaneously by default
- Sending status questions into an active executor turn
- Coop silently guessing an ambiguous target
- Persisting raw microphone audio by default
- Coupling durable conversation state to one voice or coding provider
- Exposing hidden chain-of-thought through snapshots or narration
- Two-user simultaneous voice on one session (deferred past 3B — Decision 17)

---

## Remaining Product Questions

1. Wake/address model: is "Coop" always addressable from a focused session, or only from workspace scope? (Prototype in 3B.)
2. Which events deserve unsolicited narration vs subscription ("tell me when this finishes")?
3. Naming two browser clients on one physical device without unstable identifiers.
4. Tier 1 model sizing: whisper variant (tiny/base/small) and Kokoro vs Piper on the actual daemon hardware — measure WER on his accent + Croatian code-switch (F9) before choosing.
5. How much transcript the Android companion shows without becoming a second UI.
6. Play Store vs internal APK distribution.
7. Controller brain model selection per subscription window state (Claude tier when available; Codex fallback) — automatic or user-pinned?
8. Whether "still broken" within N minutes of CONFIRM_DONE should auto-REOPEN_WORK or ask.

---

## Recommended Next Work (in order)

1. **Reliability baseline** — quiet canaries first; conversation correctness is indistinguishable from lifecycle noise without it.
2. **Phase 0 contract, slice-scoped** — the event/op/provenance/snapshot definitions above, reviewed against MODULE_MAP before any UI.
3. **Macro router + gateway + thin kernel** — deterministic value even text-only (typed "continue"/"mark as done"/"anything left?" hit the same ops).
4. **Controller brain as YOKE background session** — the subscription-auth mechanism is the architectural keystone; prove it with text before audio.
5. **Tier 0 audio on the slice** — first end-to-end spoken plan-amend-approve on a real task.
6. **Then** Tier 1 local audio, Codex snapshots, and the Phase 2+ ladder.

Do not start with wake words, multi-Mate rooms, a full Android UI, automatic device stealing, the complete claim protocol, or broad provider abstraction.

---

## Research References

- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — controller session substrate (subscription OAuth auth path already in `lib/yoke/`)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — Tier 1 STT
- [Kokoro TTS](https://github.com/hexgrad/kokoro) / [Piper](https://github.com/rhasspy/piper) — Tier 1 TTS
- [Silero VAD](https://github.com/snakers4/silero-vad) — local voice-activity detection
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) — Tier 0 (already in `stt.js`)
- [Deepgram Flux](https://deepgram.com/) · [Cartesia Sonic](https://cartesia.ai/) · [ElevenLabs](https://elevenlabs.io/) — Tier 2 options
- [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime) — evaluated and rejected as foundation (see Voice Architecture Decision)
- Android: [MediaSessionService](https://developer.android.com/media/media3/session/background-playback) · [audio focus](https://developer.android.com/media/optimize/audio-focus) · [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)

---

## Appendix A — Audio-Floor Handoff Protocol (design notes for Phase 3A)

*Status: not committed. v1 ships last-claim-wins with epoch fencing (Decision 13). The instrumented Phase 3A prototype decides how much of the following is actually needed. Preserved from v1 of this document.*

**Two-phase claim transaction**: `requested → target-ready → committing → active`, with `failed / cancelled / expired / failed-after-commit`. Target proves readiness (conversation loaded, permissions granted, playback context usable, media path live, binding unchanged) before an atomic daemon compare-and-swap against the current generation+epoch; old owner stays fully active until the irreversible barrier; post-barrier activation failure leaves the floor `unclaimed`, never restoring the old owner or silently activating the target; losing claimants never revoke or activate.

**Input barrier**: stop accepting old-owner frames at a recorded sequence; resolve the old provisional turn exactly once; fragments after the boundary are discarded and marked interrupted; audio from two devices is never spliced into one utterance.

**Output handoff (break-before-make)**: new client starts only after the old client acknowledges revocation or the short playback lease expires; clients flush queued playback on revocation, keep buffers shorter than the lease, and check the lease deadline before playing every chunk.

**Playback-offset resume**: speech segments are numbered; only *actually-played* acknowledgments (not received/buffered) count; after acknowledged handoff resume from the next offset; after partition, wait for lease expiry and speak a short handoff summary instead of guessing.

**Misc**: reconnecting old owners return synchronized-inactive, never auto-restored; pending claims have server-side expiry, are cancellable from either side, and die with their target's disconnect; a newer request from the same user supersedes an older pending one; spoken/system triggers become requests when the platform requires a local gesture ("Continue conversation" button completes them).

**Phase 3A evidence gate (unchanged)**: measure claim request→ready→commit→audio latencies (P50/P95), revocation ack + lease expiry under partition, mic/playback/suspension/Bluetooth/notification behavior on the real devices, speech-boundary stability and the felt UX of exact-offset resume vs last-phrase replay vs short-summary recovery, and accidental/abandoned/failed claim rates — before adopting budgets or committing to this machinery.

---

## Appendix B — Corpus Methodology

**Sources** (mined 2026-07-18):
- `~/.claude/projects/`: urban-stay 65 sessions (88 MB), Trialview-webapp 1, clay 96 (121 MB), v2-webapp 264 (262 MB). All 425 scanned for rare events (ExitPlanMode, AskUserQuestion, interrupts, denials); 125 deep-extracted.
- `~/.codex/sessions/`: 592 rollouts (~846 MB), all parsed for lifecycle stats; 420-message stratified sample classified; 1,697 agent-final→user-next adjacency pairs.

**Filters**: excluded tool_results, `isMeta`, sidechain messages, slash-command wrappers, and machine-injected user-slot content (auto-launch prompts, auto-resume, task notifications, handoff blocks) — which itself became finding F16. `.bak` files excluded. One grep self-contamination (this analysis session's own transcript) identified and excluded.

**Headline numbers**: ~668 Claude-side + ~2,850 Codex-side human-typed messages; interrupts ≈ 6 + 5 across ~950 sessions; "continue" family 76 + 56; approval phrase inventory and frequencies as listed in F3; AskUserQuestion 248 events (74% clean picks); ExitPlanMode 6 (5 approved-as-edited, 0 rejected); completion reports 529 (p50 231 words, 52% caveats, 12% needs-you); interstitial narration 2,234 blocks (p50 19 words); done-claim pushback 5–10% (Claude) / ~25–33% incl. negative screenshots (Codex UI work); screenshots on 10–18.5% of messages; sessions ~50% fully autonomous; 90% bypassPermissions; median session wall-clock 5.3 h (Codex high-traffic sample), max 452 h.

Working artifacts (temp, regenerate as needed): `/tmp/bojan_taxonomy/`, `/tmp/codex_analysis/` (cleaned utterances, adjacency pairs, per-file lifecycle stats, classified samples).

---

## Decision Log

| Date | Decision |
|---|---|
| 2026-07-18 | Treat conversation as a durable product lifecycle, not enhanced dictation. |
| 2026-07-18 | Separate the conversational controller from the coding executor so status does not interrupt work. |
| 2026-07-18 | Require explicit approval of a versioned plan before every implementation. |
| 2026-07-18 | Make plan corrections explicit intent diffs. |
| 2026-07-18 | Keep audio ephemeral and never speak secrets. |
| 2026-07-18 | ~~Use OpenAI Realtime as the initial candidate~~ — **superseded**: pipeline architecture (STT → text controller → TTS); speech-to-speech rejected on cost, redaction, and brain-quality grounds. |
| 2026-07-18 | Define Coop as a daemon-level workspace coordinator distinct from multi-Mate rooms. |
| 2026-07-18 | Keep Android minimal and native-hardware-focused. |
| 2026-07-18 | Read-only exploration before approval; approval before mutation; human confirmation before complete. |
| 2026-07-18 | Fence Coop targets, pending requests, and audio-floor claims against stale or replayed actions. |
| 2026-07-18 | Daemon-mediated media for cross-device handoff; equal synchronized clients; one floor owner; explicit claims only; workspace focus ≠ client navigation; measure before choosing lease budgets. |
| 2026-07-18 | **v2**: Ground the conversation model in mined session data (425 Claude sessions + 592 Codex rollouts); findings F1–F17 are normative inputs to the design. |
| 2026-07-18 | **v2**: Zero-marginal-cost constraint — conversational brain runs as a YOKE background session on existing subscription auth (Claude Team primary, Codex fallback); audio on free tiers (browser → daemon-local); paid voice is an optional adapter. ChatGPT Pro confirmed to NOT include OpenAI API/Realtime access. |
| 2026-07-18 | **v2**: Barge-in = steer; only the word "stop" stops; stop-speech before stop-work (F1). |
| 2026-07-18 | **v2**: `APPROVE_WITH_AMENDMENT` is first-class; fused approval+dispatch supported (F4). |
| 2026-07-18 | **v2**: Two-tier corrections — minor→steer (no ceremony), material→diff+re-approval (F5); classifier defaults minor. |
| 2026-07-18 | **v2**: Deterministic macro table before any model call (~25% traffic coverage, F11); status answered from snapshot templates at zero tokens. |
| 2026-07-18 | **v2**: Human-input provenance typed on every event; machine-injected turns can never approve/confirm/answer (F16). |
| 2026-07-18 | **v2**: Phase order inverted — Tier 0 voice ships in the first slice; kernel depth follows Phase 1 evidence; full audio-floor protocol demoted to Appendix A pending the 3A prototype. |
| 2026-07-18 | **v2**: Question budget (≤2 clarifying questions per task, bounded options + recommendation, assume-and-state otherwise) (F12). |
| 2026-07-18 | **v2**: Multiplayer voice on one session deferred past Phase 3B; floor scoped per user. |
