# Clay Conversation Roadmap

> Make Clay usable as an ongoing conversation: think together, agree on an explicit plan, supervise execution, make corrections, verify completion, and move between projects and sessions with minimal keyboard or mouse use.

**Created**: 2026-07-18
**Rewritten**: 2026-07-18 (v3 — archive-grounded pipeline plan, reviewed for approval safety, routing correctness, provider boundaries, and cross-device continuity)
**Status**: Planning
**Working coordinator name**: Coop

**Owner clarification, 2026-09-06**: Voice is an ongoing conversation without relying on the keyboard. With Lead on, the conversation is with Coop only. With Lead off, Voice talks to the selected individual session. Voice is a transport for the existing conversation, not a dedicated topic or a separate worker. The current browser slice and its remaining gaps are documented in [Coop Voice](../../guides/COOP_VOICE.md).

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

Before designing the conversation model, we mined the user's real archives. The corpus contains **425 Claude Code sessions across the three primary projects**, one additional Trialview session, and **592 Codex rollouts**. The archive is strong evidence for vocabulary, recurring workflows, and broad interaction patterns. Percentage estimates that depend on manual classification remain hypotheses until the privacy-safe audit artifact in Appendix B is complete. Product safety rules do not depend on an unfinished label set.

### F1 — Typed steering is overwhelmingly turn-boundary; spoken barge-in remains an experiment

Mid-turn interrupts are rare in the typed archives: **approximately 6 in Claude Code and 5 `turn_aborted` events in Codex** across the qualifying sessions. Most steering happens between turns or through a queued message. This evidence describes typed coding sessions; it does not prove how often a user will interrupt spoken output.
→ *Voice barge-in stops or ducks speech immediately, then routes the finalized utterance through the normal intent router. It never becomes an executor steer merely because it interrupted TTS. Executor interruption remains a separate explicit control.*

### F2 — "continue" is the single most frequent utterance

76× exact in Codex, 15× urban-stay, 41 keep-going nudges in clay/v2-webapp. Plus presence checks whenever the agent is slow: "alive?", "You ok", "you there", "did you stop again?".
→ *A `NUDGE` fast-path (zero-token, deterministic) and proactive spoken progress ("still building…") that preempts presence checks.*

### F3 — The approval vocabulary is tiny, lowercase, and typo-ridden

Observed pure approvals, by frequency: `continue`, `yes`, `ok do it` (26×), `do it`, `ok`, `go`, `sure`, `do that`, `do both`, `ship it`, `add it`, `implement`, `let's do it`, `please do`, bare option tokens `1` / `a` / `B` / `num 3`, and emphasis-caps `DO ALL MODULES`. **Never** "approved", "LGTM", or "sounds good, proceed".
→ *Spoken approval detection keys on a small closed phrase set + option-token resolution against the agent's last enumeration — not on formal language.*

### F4 — Approvals carry riders; plans are edited, not rejected

Conditional or fused approvals are common: "yes, and commit and push", "Yes, but keep Analytics top-level", "ok try it but don't commit untill I'm happy with it", "do b2 and C, but…", "1 yes, 2 not needed". The formal ExitPlanMode approvals found in the archive were edited visibly by the user before approval. They do not prove that a model-interpreted spoken amendment is safe to approve before the user hears the resulting version.
→ *The router must split approval riders. A rider creates a pending amended plan version, Clay narrates the concise diff, and the user approves that exact version. Fused post-approval operations remain ordered but keep their own authorization requirements.*

### F5 — The preliminary sample contains both minor and material corrections, with recognizable material markers

Minor corrections are often short fragments such as "also the color", "just the lower line", or "reduce length of spikes by 10%". Material corrections often open with **"you missunderstood" / "you missed the point" / "i said" / "like I said" / "no no no"** and may restate the whole flow. Some short corrections, such as "no need for two emails", still change scope, so phrase shape alone is not an authorization boundary.
→ *Two-tier correction routing remains useful, but immediate steering is limited to clearly bounded implementation details that preserve goal, approach, constraints, and acceptance criteria. Uncertain or material changes produce a pending intent diff and require approval. Stop prevents further work; it is not undo.*

### F6 — The debug/verify loop is the product, not the new-task flow

~35% of all typed traffic is the loop: bug report (often screenshot-first) → fix claim → user tests → "didn't work" / "still no go" / "still flashing…" → fix → terse pass ("works now", "seems to b4e ok now"). "New task" is only 7–9%. Done-claims are immediately contested **5–10%** of the time in Claude sessions and **up to a quarter to a third** in UI-heavy Codex work (counting negative screenshot replies). Typical rounds to actually-done: 1–3, tail 4–5.
→ *After speaking a completion, keep the just-finished context hot and expect "still broken" as the next utterance. Never treat "done" as closing.*

### F7 — Screenshots are load-bearing; voice needs the visual channel

10–18.5% of Claude-side messages and 14% of Codex-side messages carry images; some are image-only ("here", "another one", or literally no text). 24% of post-done Codex replies are screenshots. Deixis is heavy: "just the lower line", "this goes to new row", "same apply for this".
→ *Voice is a companion to the screen, not a replacement. The engine needs turn-scoped anaphora resolution (resolve "this" against the last agent utterance / current view) and a spoken escape hatch: "I'll send a screenshot" pauses the turn awaiting an image.*

### F8 — Multi-intent utterances are routine

Multi-intent messages are routine in the inspected samples: "why didn't address come from guesty… and why don't we parse doc on choose file… and please buttons still have no feedback" (3 bug reports); question + feature ask; approval + correction; numbered multi-part replies mirroring the agent's enumeration ("1. … 2. … 4a: …"). The exact 6–15% estimate remains provisional until Appendix B's labeling audit is complete.
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
2. Clay adds useful possibilities, challenges weak assumptions, and asks only questions that materially change the outcome. Questions use 2–3 options and a recommendation; after two exploratory questions Clay asks whether to keep probing or draft the plan (F12).
3. Clay and the user settle on a concrete plan with acceptance criteria and known caveats.
4. A spoken amendment creates a pending plan version. Clay reads the concise change back **as the approval prompt itself**, so a single "yes" completes it — the amend→approve ceremony costs exactly one word, and Phase 1 measures amendment friction (F4, F12).
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
3. **Every implementation requires explicit plan approval.** Approval names a specific immutable plan version. A spoken amendment creates a pending version; Clay narrates the exact intent diff before the user approves it. The controller may recommend approval but cannot grant it or approve its own interpretation.
4. **Corrections are tiered.** A clearly bounded implementation detail that preserves goal, approach, constraints, and acceptance criteria may queue as a minor steer. A material or uncertain change creates an intent diff, a pending plan version, and a new approval. The classifier never treats "stop" as undo and never defaults an uncertain state-changing correction to minor.
5. **Stop, pause, continue, status, target selection, approval, and closeout are deterministic controls** resolved by a typed gateway, not model improvisation. A ~25%-coverage phrase-macro table (F11) runs before any model sees the utterance.
6. **Barge-in stops speech, then routes normally.** It does not imply a steer. Only an explicitly classified and authorized correction enters the executor lane; `STOP_WORK` remains separate from `STOP_SPEECH`. (F1)
7. **The daemon is authoritative.** Conversation state survives reloads, daemon restarts, compaction, provider handoffs, and device switches. (F17)
8. **Voice and text share one transcript and lifecycle.** Audio is ephemeral; durable records are transcripts, decisions, plan versions, summaries, outcomes.
9. **Secrets are never spoken or durably retained through conversation mode.** Redaction covers inbound confirmed transcripts, persisted snapshots, narration, and the final text sent to TTS.
10. **Human-input provenance is typed and assigned at trusted ingress.** Machine-injected user-slot turns, synthesized speech, replayed audio, TTS echo, client/model provenance claims, and other agents can never approve, confirm done, dispatch closeout, or answer destructive confirms.
11. **Zero-new-service-spend core.** The preferred controller uses the locally authenticated YOKE subscription path only after Phase 0 verifies usage and overage behavior; browser or daemon-local audio requires no paid voice API. Paid providers remain optional adapters. (Owner constraint; see Voice Architecture Decision.)
12. **Pipeline architecture (STT → text controller → TTS), not speech-to-speech.** Decided — see below.
13. **Exactly one client owns the live audio floor.** Transfer requires target readiness, an atomic fenced claim, and break-before-make output. Real-device evidence selects lease durations and speech-resume behavior; it does not decide whether readiness and output fencing exist. See Appendix A.
14. **Coop and multi-Mate rooms are separate concepts.** Coop coordinates the workspace; a room moderates participants inside one task.
15. **Android is a hardware companion, not a second Clay application.**
16. **Shared conversation does not force shared navigation.** Workspace conversational focus is durable and shared; each client browses independently.
17. **Multiplayer scope (v1):** the audio floor and conversation lifecycle are scoped per-user. Two teammates conversing simultaneously with the same session is explicitly out of scope until after Phase 3B; their text/steer paths continue to work as today.
18. **Scope of the conversation lifecycle.** These rules govern **conversation-managed sessions** — sessions with an active conversation attached. Auto-launched/autonomous sessions (~50% of real traffic, F13) keep today's automation-mode semantics (launch prompts, completion markers, auto-continue) and are visible to conversation mode read-only (status, Coop triage). A human may explicitly *adopt* an autonomous session into a conversation; adoption snapshots its current state as the baseline intent, after which the approval discipline applies to new work. Invariants bind operations flowing through the conversation gateway; they do not retroactively govern non-conversation automation.

---

## Voice Architecture Decision: Pipeline, Not Speech-to-Speech

Two possible architectures existed:

**(A) Speech-to-speech** — OpenAI Realtime (gpt-realtime-2) as both ears and brain. Best latency and turn-taking. Rejected, on three independent grounds:

1. **Cost/subscription**: ChatGPT Pro does **not** include OpenAI API access; Realtime is separate pay-per-use at $32/$64 per M audio tokens ≈ **$0.10–0.45/min** in practice (~$0.05–0.10/min with aggressive caching). An all-day ambient session is $20–80/day of new spend. Violates Decision 11 outright.
2. **Redaction**: "secrets are never spoken" is only enforceable if there is a *text* artifact between the brain and the speaker. A speech-to-speech model's audio output cannot be reliably redacted or tested against secret fixtures. Violates Decision 9.
3. **Brain quality/coherence**: the conversational brain would be a different vendor's voice-tuned model reasoning about Claude's plans and snapshots, with no access to Clay's session context, memory, or permission system.

**(B) Pipeline** — streaming STT → text conversational controller → streaming TTS. Chosen. Latency is worse; the initial Tier 1 target is first spoken syllable within 2.5 s after confirmed intent, then tuned from measured P50/P95 results. The controller becomes a first-class Clay citizen:

### The conversational controller is a YOKE session on subscription auth

The controller is **not** a new metered API client. It is a lightweight background session driven through the exact same machinery that runs coding sessions today:

- Spawned via `yoke` (Claude adapter) using the same locally authenticated Claude Code path Clay already exercises when `ANTHROPIC_API_KEY` is absent. **Phase 0 must verify this as a supported, durable controller path under the installed Agent SDK and the user's subscription**, including rate-limit and extra-usage behavior. The core must stop or fall back rather than silently incur metered overage.
- Precedent already in the codebase: `sdk-bridge-mentions.js` maintains *persistent read-only @mention query sessions* — the controller is architecturally the same animal with a different system prompt and toolset.
- **Toolset**: read-only. It can read the conversation ledger, plan versions, executor snapshots, and bounded session context. Its only write path is *proposing typed gateway operations* as untrusted structured output, which a runtime schema and the daemon gateway validate. It can never edit files or talk to the executor directly.
- **Vendor-portable contract, verified per adapter**: the Codex fallback must start with `sandboxMode: "read-only"`, deny write-capable tools, and pass a negative write test before it is eligible. YOKE's current Codex default is `danger-full-access` (`lib/codex-defaults.js`), which makes the negative write test non-negotiable; portability is a goal, not a safety assumption.
- **Usage-window discipline** (it burns subscription quota, so): system prompt frozen and cache-friendly; snapshots delivered as compact structured text; deterministic macro layer (F11) answers ~25% of utterances with zero controller tokens; `GET_STATUS` answered by template from the snapshot (zero tokens) unless the user asks a *why* question; controller turns targeted at &lt; 500 output tokens.
- **Disposable context, durable ledger** (F17: conversations run for days–weeks; the controller session itself will hit compaction): all authoritative conversation state — pending enumeration, plan versions, lifecycle phase, question set — lives in the ledger and is **re-injected on spawn**, never resident only in controller context. The controller session is therefore recyclable at any time: fresh session per N turns, on compaction, or on drift, with zero state loss. Post-compaction fidelity (does it still resolve the pending enumeration and plan version correctly?) is a Phase 0 spike item, and the pending-enumeration re-injection path is exercised on every recycle, not just failures.

### Audio I/O: a three-tier ladder behind one adapter interface

One provider-neutral interface (`stt-adapter` / `tts-adapter` contracts, negotiated per client+daemon capability), three tiers:

| Tier | STT | TTS | Cost | Latency | Notes |
|---|---|---|---|---|---|
| **0 — Browser** (first slice) | Web Speech API — already integrated in `lib/public/modules/stt.js` (continuous + interim, 7 configured languages) | `speechSynthesis` — broadly available, with browser/voice differences | **$0 to Clay** | STT good on supported Chrome; TTS starts quickly | `SpeechRecognition` is not cross-browser baseline and may send audio to the browser vendor; desktop Chrome only for the first proof |
| **1 — Daemon-local** (Phase 2) | whisper.cpp / faster-whisper on the daemon host (realtime+ on Apple Silicon; multilingual incl. Croatian — F9) | Kokoro (open-weights, near-commercial quality, realtime on M-series) or Piper; macOS `say` as trivial fallback | **$0** | ~300–800 ms STT finalize; ~100–300 ms TTS first audio | Private (audio never leaves the machine); serves **all clients incl. phone** via daemon-mediated audio over the existing WS; this is the workhorse tier |
| **2 — Paid cloud** (optional, never required) | Deepgram Flux (~$0.46/hr streaming, built-in end-of-turn detection) or OpenAI realtime transcription (~$0.46/hr) | Cartesia Sonic (~90 ms TTFA, $50/M chars) / Deepgram Aura ($15/M chars) / ElevenLabs ($66/M chars) | ~$0.50–1.00/hr active | best-in-class | Pluggable adapter; config per user; off by default |

End-of-turn detection: Tier 0 uses Web Speech finalization + a configurable silence timer + push-to-talk override; Tier 1 adds local VAD (e.g. Silero) in front of whisper; Tier 2 (Flux) has it natively. At every tier, barge-in first ducks and cancels local playback. The finalized transcript then enters the same phase-aware router as any other utterance. Phase 0 must define duplex/echo handling so Clay's own synthesized speech cannot become live-human input or approve an action.

### Cost model (for the record)

| Path | Marginal cost of a 6 h working day |
|---|---|
| Chosen: Tier 0/1 audio + subscription controller | **$0 new service spend when subscription usage remains included**; local compute/electricity and optional overage are measured separately |
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
Web, PWA, and native clients are equal views of one durable conversation. Any client can request the audio floor through an explicit **Continue here** gesture. The target must prove readiness before the daemon commits the fenced transfer and revokes the old owner. Appendix A defines the minimum protocol; the Phase 3A prototype tunes its budgets and resume experience.

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
│              │     (verified subscription path, read-only tools,      │
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
mic audio → STT tier → confirmed transcript
  → daemon-assigned provenance + current {generation, leaseId, epoch} binding
  → phase-aware deterministic macro table (read-only and exact control paths)
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

**Audio floor**: `unclaimed → requested → target-ready → committing → active(client, device, user, daemonGeneration, leaseId, epoch)`, with `failed / cancelled / expired / failed-after-commit`. The old owner stays active until the target proves readiness and the daemon commits atomically. Loss of the active owner returns the floor to `unclaimed`; a daemon restart creates a new generation and invalidates every old lease. See Appendix A.

---

## Intent Router (data-grounded)

Three stages, cheapest first:

### Stage 1 — Phase-aware deterministic macro table (no tokens, &lt;10 ms)

The vocabulary covers roughly a quarter of observed traffic (F11), but words do not have global meanings. The current lifecycle, pending request, and executor state select the operation first:

| Context | Utterance family | Op |
|---|---|---|
| plan version awaiting approval | "continue", "yes", "ok", "do it", "go", option token | approval resolution (Stage 1.5) |
| executor paused | "continue", "keep going" | `CONTINUE` |
| executor working or apparently stalled | "continue", "continye", "retry" | `NUDGE` |
| TTS speaking | bare "stop" | `STOP_SPEECH` |
| no TTS; executor active | bare "stop" | ask "Stop the work too?"; no work mutation yet |
| any authorized active-work state | "stop the work", "kill it" | `STOP_WORK` |
| any state | "what's next", "anything left", "are you done", "status" | `GET_STATUS` |
| any state | "commited and pushed?" | `GET_STATUS(git)` |
| approved plan with requested repository step | "commit push", "commit and push" | ordered closeout operation, subject to the approved plan and repository policy |
| verified `closeout` only | "mark as done", "ship it", "call it done" | `CONFIRM_DONE` |
| any other state | "ship it" | approval or dispatch candidate; resolve from pending context, never infer completion |
| any state | "wrong chat", "wrong session" | focus correction; offer last-focused alternatives |

Fuzzy matching is allowed for read-only macros and non-authorizing suggestions. A fuzzy match may never directly approve, stop work, dispatch repository/runtime operations, answer a permission, or confirm done. State-changing commands require an exact normalized phrase or a concise read-back and explicit confirmation. This prevents short collisions such as "go"/"no" and "ship"/"skip" from becoming actions.

### Stage 1.5 — Approval & enumeration resolver

Maintains the *last agent enumeration* (options, plan version, question set). Resolves option tokens, partial approvals ("1 yes, 2 not needed"), and detects riders. A post-approval rider is re-fed to Stage 2 as a separately authorized intent ("yes, and commit and push" → approve, then evaluate the repository operation in order). An amendment rider creates a pending version ("Yes, but keep Analytics top-level" → `AMEND_PLAN_VERSION`), after which Clay reads the concise diff and asks for approval of the new version. Spoken plan approvals always read back the version ID and one-line goal before acceptance.

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
  "proposed_ops": [{"op": "QUEUE_EXECUTOR_STEER", "payload": "..."}]
}
```

Classifier kinds mirror the empirical taxonomy (F-table): `new_task, exploration, plan_feedback, approval, correction_minor, correction_material, status, bug_report, test_report, info_supply, question, ops, closeout, stop, context_switch, coordination` (multi-session talk → Coop hook), plus `defer` and `screenshot_pending` (F7, F12).

### Correction routing (Decision 4)

`correction_minor` is allowed only when a comparison against the approved intent confirms that goal, approach, constraints, and acceptance criteria remain unchanged. The gateway queues it for the executor's **next safe tool-call boundary** — seconds away, not the end of the turn (turn p90 is ~7 minutes, F17; a minor correction that waits for turn end lets the executor do wrong work for minutes) — and narrates one line stating *when* it applies ("Queued — applies after the current test run.") so the user doesn't re-issue it (F2: he re-pokes anything that looks unacknowledged). If no boundary occurs within a short configurable window, Clay offers `INTERRUPT_AND_STEER` explicitly. It does **not** reuse the current abort+auto-resume steer path unchanged. An explicit user request to interrupt active work is a separate control. `correction_material` produces a pending correction diff (what changed / affected work / changed criteria / plan still valid? / recommendation), speaks it in ≤ 3 sentences, and awaits approval of the resulting version. When classification is uncertain, Clay asks one bounded question and performs no state-changing dispatch until resolved.

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
- **Amend-then-approve is first-class**: `AMEND_PLAN_VERSION` records the verbatim amendment, creates a pending immutable version, and produces a concise intent diff. Clay narrates that diff before a later `APPROVE_PLAN_VERSION` can authorize it. The controller never approves its own interpretation. (F4)
- Fused approval+dispatch ("yes, and push") is split and ordered. Approval can succeed while a repository/runtime operation is rejected, confirmed separately, or withheld because the approved plan does not authorize it.
- Approval binds daemon-verified live-human provenance (F16), immutable project/session target, and the exact version. Provenance is assigned at trusted ingress and is never accepted from a client or model payload. Spoken plan approvals always receive a version/goal read-back before acceptance.
- "sounds reasonable", "makes sense" = conversational agreement, **not** approval. The detector is the F3 phrase set + option tokens, not sentiment.
- Synthesized speech, replayed audio, another agent, or machine-injected text can never approve.

### Pre-approval mutation boundary
Before approval: converse, inspect, search, read-only investigation, non-mutating repro, plan drafting. Not allowed: file edits, repo/runtime mutation, executor instructions, external actions. The approved plan authorizes only what it names; goal/approach/constraints/criteria changes require a new version. Destructive/deploy/publish/merge/external actions keep their own confirms (F13: these are the only gates the user actually still uses — make them crisp spoken confirms with the consequence stated: "Dropping 3 stashes is unrecoverable — drop them?"). Destructive confirms require a **consequence-echo answer** — "drop them" / "confirm drop" — never a bare one-syllable "yes"/"no": a single-syllable ASR flip is worst exactly here, and F13 says these confirms are the only permission gates still in real use.

### Correction diffs
On material correction, state: what changed; which completed/active work is affected; which acceptance criteria changed; whether the plan remains valid; recommendation. Spoken in ≤ 3 sentences; full diff visual.

### Closeout
Executor "done" → `verifying`/`closeout`, never `complete` (Invariant 8). Verification prefers **agent-driven proof** (run lint/build/smoke, read the result aloud — the Codex "Verified:" format, F6/F14) so the user's own testing round shrinks. Only live-human `CONFIRM_DONE` ("mark as done", "ship it") completes. `REOPEN_WORK` re-enters with history intact and is expected traffic, not an edge case.

---

## Deterministic Control Gateway

Typed operations; each carries target, idempotency key, server-assigned authorization/provenance context, expected lifecycle state/version, and result. Only gateway ops change authoritative state. Every controller proposal and WebSocket payload is untrusted until it passes a runtime decoder and operation-specific policy checks; `ws-schema.js` remains a registry, not the validator.

`STOP_SPEECH` · `STOP_WORK` · `PAUSE` · `CONTINUE` · `NUDGE` · `GET_STATUS` · `QUEUE_EXECUTOR_STEER` · `INTERRUPT_AND_STEER` · `FOCUS_TARGET` · `AMEND_PLAN_VERSION` · `APPROVE_PLAN_VERSION` · `REJECT_PLAN_VERSION` · `REQUEST_PLAN_REVISION` · `SEND_APPROVED_INTENT` · `ANSWER_PERMISSION` · `ANSWER_QUESTION` · `RUN_APPROVED_CLOSEOUT` · `CONFIRM_DONE` · `REOPEN_WORK` · `END_CONVERSATION` · `REQUEST_AUDIO_FLOOR` · `COMMIT_AUDIO_FLOOR` · `RELEASE_AUDIO_FLOOR`

Rules: "stop talking" ≠ "stop the work"; ambiguous "stop" silences speech immediately, then asks before affecting work. `ANSWER_PERMISSION` and `ANSWER_QUESTION` bind the exact still-pending request ID and accepted option set. `CONTINUE` resumes a paused executor; `NUDGE` only requests a truthful liveness check and never approves, resumes, or duplicates executor input. `RUN_APPROVED_CLOSEOUT` can perform only repository/runtime steps named by the approved plan and project rules. `APPROVE_PLAN_VERSION` *authorizes*; `SEND_APPROVED_INTENT` *dispatches* it to the executor exactly once (Invariant 3) — the gateway fuses them when the user's approval implies immediate start, but they remain distinct ops so approval without dispatch is expressible. `END_CONVERSATION` ends conversation mode only: releases the floor, stops speech, persists the ledger; the executor is unaffected. Every op is idempotent under reconnect/replay.

---

## Spoken Response Policy (data-grounded)

- **Speak**: conclusions, bounded questions (2–3 options + recommendation), decisions, plan summaries, state *transitions* (tests pass/fail, push done, retry, unexpected discovery), blockers/needs-you, caveats, destructive confirms.
- **Don't speak**: logs, tool calls, file paths, line numbers, diffs, per-edit narration, token-by-token anything, secrets (redaction layer is mandatory and test-gated), routine progress.
- **Speakable-field sanitation**: snapshot fields spoken verbatim (`currentStep`, `caveats`, `needsYou`) are length-capped and sanitized before TTS. They derive from executor output, which derives from file/web content — adversarial or garbage text being *spoken aloud* is its own failure mode, distinct from injected content attempting approval. Fixture-tested alongside the secret fixtures.
- **Instant acknowledgment**: when an utterance leaves the macro path for the controller brain, emit an immediate deterministic ack — a short earcon or templated "on it" — within ~300 ms. Human turn-taking tolerance is ~700 ms before silence reads as failure, and this user demonstrably probes silence ("alive?", "you there" — F2). The ack is zero-token and client-local; the brain's real reply replaces it.
- **Completion utterance** = verdict word first, then caveats, then needs-you, then offered next action; 30–60 words (F14). Then stay hot for "still broken" (F6).
- **Status utterance** = one breath from the snapshot with strict precedence: stale/disconnected → failure/blocker → pending human question/permission → current step → verification result → git/closeout state. A stale snapshot states its age and confidence instead of sounding healthy. Template-generated (zero tokens); the brain engages only for *why* questions.
- **Plan narration** = goal (user's own words) → in/out of scope → approach in one sentence → locked decisions/risks → verification method; 60–90 words; full plan stays visual (F14: ~75% of plan text is noise aloud).
- **Proactive progress**: during long turns (p90 = 7 min, F17), a short spoken pulse at meaningful transitions only — calibrated to preempt "alive?" checks without narrating routine steps. User-configurable cadence, server-side setting.
- **Question budget**: during execution, avoid more than two consecutive blocking clarification turns before recommending a safe assumption, deferral, or bounded choice. Exploration has no global two-question ceiling; after two questions Clay asks whether to keep probing or draft the plan. Explicit interview/spec modes can go deeper. (F12)
- **Long content**: appears in the transcript with a spoken offer to summarize aloud.
- Accessibility: every audio-only state has a visual equivalent; text input and controls remain available at all times.

---

## Persistence, Privacy, Recovery

**Durable**: conversation lifecycle + focus; redacted confirmed transcripts (with server-assigned provenance class per event); intent commits, decisions, plan versions, approvals, amendments; normalized redacted snapshots + attention events; device registrations (human-readable names, revocable) + route preferences; closeout summaries. Storage uses a Clay-owned `conversationId`, with immutable executor-session bindings recorded in the ledger so provider handoff cannot change identity. Phase 0 defines versioned event envelopes, monotone sequence numbers, causation IDs, atomic append, partial-tail recovery, replay checkpoints, and migration behavior under `~/.clay/conversations/`.

**Ephemeral**: raw mic audio; the unredacted recognition result; synthesized audio buffers; provisional transcript fragments after finalization; voice-provider credentials.

**Protections**: always display the active mic, floor owner, and device name; state where media is processed and that third-party retention is governed by that provider; redact inbound confirmed transcripts before persistence and outbound controller/narration text before every TTS adapter; redact snapshot fields before persistence; never speak secrets/credentials/env values/unredacted logs; keep secret fixtures test-gated across all three paths; server-side settings only (no localStorage); revocable auditable device registrations; restart recovery without duplicating the last utterance or executor instruction.

---

## Implementation Map (module-level)

Per `MODULE_MAP.md` and `CLIENT_MODULE_DEPS.md`: `attachXxx(ctx)` for attached features, ≤ 500 lines/module, no inline logic in `project.js` handleMessage, client state in `store.js`, WebSocket access through `ws-ref.js`, direct imports instead of context initializers, `var`/no-arrow-functions, server CommonJS, client ES modules.

### Server (lib/)

| Module | Concern |
|---|---|
| `conversation-protocol.js` | Runtime decoders for event envelopes and controller proposals; schema/version/provenance boundary |
| `conversation-kernel.js` | Pure lifecycle reducer across the independent state machines; no I/O |
| `conversation-ledger.js` | Atomic JSONL append, checkpoints, replay, partial-tail recovery, migrations |
| `conversation-gateway.js` | Typed ops: validation, provenance checks, idempotency, dispatch to executor/ledger |
| `conversation-router.js` | Phase-aware macro table + safe fuzzy suggestions + approval/enumeration resolver |
| `conversation-controller.js` | Controller brain: spawns/maintains the YOKE background session (mention-session pattern), builds compact context (snapshot header + enumeration + last turns), parses structured proposals |
| `conversation-snapshot.js` | Reduces YOKE adapter events into the snapshot schema; persistence; staleness marking |
| `conversation-scaffold.js` | Executor system-prompt addendum (externalize the five silent-decision categories, needs-you list, verification report format) injected via YOKE instruction merge |
| `conversation-redaction.js` | Never-speak policy: secret patterns, env values, credential shapes; test fixtures |
| `conversation-narration.js` | Template speech: status/completion/plan compression per the Spoken Response Policy |
| `conversation-media.js` | Media WS frames (Tier 1/2): mic ingest and TTS egress fenced by generation+lease+epoch; backpressure and bounded buffers |
| `voice-adapters/stt-local.js`, `voice-adapters/tts-local.js` | Tier 1: whisper.cpp / Kokoro child processes (worker-forked, off the daemon event loop like `task-source-worker.js`) |
| `voice-adapters/stt-cloud.js`, `voice-adapters/tts-cloud.js` | Tier 2 optional adapters behind the same contract |
| `server-coordination.js` | Persistent daemon-level WS channel (presence, focus, claim state, attention events, Coop routing) — a new focused module, **not** an extension of `server-global-ws.js` |
| `coop-resolver.js`, `coop-attention.js`, `coop-narrator.js` (Phase 3B) | Target resolution (reusing `server-palette.js` BM25 + recency), attention queue, cross-session narration |

Message routing: new `conversation_*` / `voice_*` / `coord_*` WS types are documented in `ws-schema.js`, decoded at runtime by `conversation-protocol.js`, and dispatched from `project-message-router.js` (session-scoped) or the coordination channel (workspace-scoped). Minor steering gets a focused queue-at-boundary adapter; it does not reuse `dispatchPreparedToSdk`'s abort+auto-resume behavior unchanged.

### Client (lib/public/modules/)

| Module | Concern |
|---|---|
| `store.js` | Add conversation state/actions: media, floor, lifecycle, transcript, pending enumeration; this remains the only client state owner |
| `convo-mic.js` | Capture: Tier 0 Web Speech wrapper (shares permission UX with `stt.js`) or getUserMedia→WS frames for Tier 1/2; VAD hooks; push-to-talk |
| `convo-speaker.js` | Playback: `speechSynthesis` (Tier 0) or streamed audio chunks; barge-in duck/cancel; generation+lease+epoch checks |
| `convo-ui.js` | Conversation mode UI: floor indicator ("Listening · Working"), live transcript with provisional/confirmed styling, Continue-here button, stop-speech vs stop-work controls |
| `convo-transcript.js` | Rendering the shared transcript + plan cards / approval read-backs into the message stream (reuses `tools-plan.js` plan cards) |

`stt.js` remains untouched as composer dictation. No `localStorage`; voice settings (tier, voice, progress cadence, question budget) go server-side via the settings plumbing.

---

## Reliability Baseline (precondition)

Existing stalls, phantom reconnects, resume spam, and UI lag are conversation-correctness risks. Before Phase 1 begins, run the documented diagnostics (`docs/guides/DIAGNOSTICS.md`), record a quiet baseline in `~/.clay/recovery-events-dev.log` / `diag-dev.log`, and gate every phase exit on the canaries staying quiet.

---

## Delivery Phases

Rough effort sizing (defends the prioritization against scope pressure): Phase 0 **S–M** · Phase 1 **L** (1a M, 1b M) · Phase 2 **L** · Phase 3A **M–L** · Phase 3B **M** · Phase 4 **L** · Phase 5 **XL**. Anything proposing to jump the ladder pays its size up front.

### Phase 0 — Contract, scoped to the first slice

Lock semantics before UI/media detail, but only what the slice needs:

- [ ] Versioned runtime-decoded event envelopes for control ops, lifecycle transitions, intent commits, snapshots, provenance, media frames, and claim state. `ws-schema.js` documents these types but does not enforce them.
- [ ] Idempotency, monotone sequencing, causation, acknowledgement, reconnect/replay, partial-tail recovery, and migration behavior.
- [ ] Trusted-ingress provenance assignment. Clients and models cannot self-declare `live-human`; TTS echo, replay, machine injections, and agent proposals remain non-authorizing.
- [ ] Snapshot schema (above) + adapter mapping tables for Claude and Codex events.
- [ ] Phase-aware macro table + approval phrase set. Fuzzy matches cannot directly authorize state-changing operations.
- [ ] Inbound transcript, snapshot, narration, and outbound TTS redaction policy + secret fixtures.
- [ ] Tier 0 duplex/echo contract: microphone/TTS arbitration, cancellation ordering, and approval gating.
- [ ] Claude subscription-controller spike: long-lived query, usage-window exhaustion, extra-usage guard, restart, and structured-proposal validation. Codex fallback must prove read-only sandboxing. Controller recycle fidelity: after a fresh spawn or compaction, ledger re-injection must restore the pending enumeration, plan version, and lifecycle phase correctly.
- [ ] Persistent coordination channel spec plus minimum safe claim transaction: target readiness, atomic compare-and-swap, generation+lease+epoch binding, bounded output buffers, and revocation acknowledgement/expiry. Implementation lands in Phase 3A.
- [ ] Timing instrumentation points (mic start, transcript, route, brain, gateway, TTS-first-audio, floor ops).
- [ ] Privacy-safe corpus audit artifact started (see Appendix B): evidence table for F1–F17 with `verified-count / verified-sample / qualitative / hypothesis` markings. Percentages stay non-normative until their rows are complete; this item does **not** block Phase 1 prototype work.
- [ ] Reliability baseline recorded before Phase 1 begins.

**Exit**: the same simulated conversation runs through text and scripted-voice fixtures without changing lifecycle semantics; unsafe payloads fail closed; approval, restart replay, TTS echo, and claim-state fixtures pass. Coop events and timing choices remain deferred.

### Phase 1 — Vertical slice: thin kernel + Tier 0 voice (desktop Chrome)

The inversion from v1 of this doc: voice is in the *first* slice, kernel depth follows evidence. Run as two sub-gates: **1a — text-only** (kernel + router + gateway + controller, driven through the composer; deterministic value on its own) then **1b — voice** (Tier 0 audio on top). The exit criteria below gate 1b.

Tier 0 provisional latency budgets (the "feel" experiment needs a yardstick): macro path &lt; 500 ms; brain path first spoken syllable ≤ 4 s. Every utterance logs per-stage timings; **Phase 1 "feel" verdicts are drawn only from utterances that met budget**, so concept failure is separable from tier failure — if Tier 0 misses budget chronically, the verdict is "upgrade the tier", not "voice doesn't work".

- [ ] Thin kernel: lifecycle reducer + ledger persistence + runtime protocol validation + gateway with `STOP_SPEECH/STOP_WORK/PAUSE/CONTINUE/NUDGE/GET_STATUS/QUEUE_EXECUTOR_STEER/INTERRUPT_AND_STEER/AMEND_PLAN_VERSION/APPROVE_PLAN_VERSION/REJECT_PLAN_VERSION/REQUEST_PLAN_REVISION/SEND_APPROVED_INTENT/ANSWER_QUESTION/ANSWER_PERMISSION/RUN_APPROVED_CLOSEOUT/CONFIRM_DONE/REOPEN_WORK` — rejecting or pushing back on a plan by voice is core F12 traffic, so the "no" path ships with the "yes" path.
- [ ] Phase-aware Stage 1 macro router + enumeration/approval resolver; exact/confirmed recognition for state-changing controls.
- [ ] Controller brain as a verified YOKE background session, read-only tools, runtime-validated structured proposals, usage-window guard, and text fallback if unavailable.
- [ ] Snapshot v1 for the Claude adapter (Codex next phase); executor scaffold addendum.
- [ ] Tier 0 audio in desktop Chrome: Web Speech capture + `speechSynthesis`, silence-timer end-of-turn + push-to-talk, defined half/full-duplex behavior, echo tests, and barge-in = stop speech then route normally.
- [ ] Spoken plan review; amend → narrated diff → exact-version approval; spoken status with stale/failure/pending precedence; spoken completion; bounded minor-steer queue; material correction re-approval.
- [ ] Verbally answer one executor question and one destructive permission prompt, then pause and continue work without confusing those operations with `NUDGE`.
- [ ] Inbound, snapshot, narration, and TTS redaction live; text composer and visible plan/transcript remain parallel inputs throughout; screenshot-pending can attach an image to the active conversation turn.
- [ ] Truthful visual working/waiting presence plus a minimal spoken progress pulse after a configurable silence threshold or meaningful transition.
- [ ] One project, one executor session, one client. Measure everything.

**Exit**: both north-star workflows complete on a real task in desktop Chrome: explore/diagnose, amend and hear the diff, approve the exact version, pause/continue, answer a pending question, ask non-interrupting status, apply minor and material corrections safely, verify, run authorized closeout, confirm done, and re-enter on "still broken". No synthesized or fuzzy-recognized speech authorizes an action; canaries remain quiet.

### Phase 2 — Tier 1 audio + kernel hardening

- [ ] Daemon-local STT/TTS workers (whisper.cpp/faster-whisper + Kokoro/Piper), local VAD, adapter contract + capability negotiation between tiers.
- [ ] Daemon-mediated media frames over WS (this is also the substrate Phase 3A needs).
- [ ] Codex snapshot adapter; provider handoff continuity for the conversation ledger.
- [ ] Correction-tier classifier tuning from Phase 1 labeled examples; execution question-budget enforcement; richer proactive progress policies.
- [ ] Croatian/mixed-language STT validation (F9).
- [ ] Restart/compaction recovery exercises; intent-commit history UI.

**Exit**: the daily loop runs all day on Tier 1 at $0 marginal cost, private, with the phone browser usable as a *stationary* second client (no live handoff yet).

### Phase 3A — Cross-device continuity (browser proof)

- [ ] Persistent coordination channel implementation (presence, device names server-side, floor state fan-out).
- [ ] **Continue here** request; target proves conversation, permission, playback, and media readiness; daemon commits with atomic compare-and-swap against `{daemonGeneration, leaseId, epoch}` before revoking the old owner.
- [ ] Break-before-make output: old owner acknowledgement or lease expiry before new playback, bounded buffers shorter than the lease, per-chunk lease validation, and deterministic provisional-input resolution.
- [ ] Instrumented two-client prototype: desktop Chrome ⇄ Android Chrome/PWA, measuring claim latency, audio resume, suspension/lock/network-handoff behavior, accidental-claim rate.
- [ ] **Evidence gate**: measurement chooses lease budgets and the speech-resume policy. Target readiness, atomic commit, input fencing, and break-before-make output are not optional.

**Exit**: start on the laptop, claim on the phone, continue the same conversation, return — without losing state, duplicating a turn, or echo; measured numbers recorded here.

### Phase 3B — Coop (parallel with 3A after Phase 2)

- [ ] Coordination channel extensions: target resolution (server-palette inputs + recency + pending decisions), immutable target bindings revalidated at dispatch, attention queue (permissions, blocked, failures, completions awaiting closeout, stale sessions).
- [ ] Focus/switch commands for connected clients; workspace-level Coop ledger; explicit-ambiguity questions ("I found 'Voice roadmap' in clay, session 14 — switch?").
- [ ] The user's real coordination vocabulary as seed grammar: "what needs me", "get me the one working on X", "the other session already took #122", "wrong chat" (F17).
- [ ] Test stale/missing/completed/duplicate/permission-denied targets. Bulk commands deferred.

**Exit**: find a session by topic, act on its pending decision, switch projects, start a new task — hands-free.

### Phase 4 — Minimal native Android companion

Entry gate = concrete measured browser failures in background/screen-off operation, mic/playback suspension, Bluetooth/audio focus, headset/lock-screen controls, or lifecycle recovery. Kotlin/Compose, not a WebView shell; sign-in + device registration, conversation/status screen, PTT + mode + mute + stop controls, foreground service + media session, deep links into the web UI. **Continue here** is the guaranteed local claim action. Spoken, headset, notification, lock-screen, and system triggers request a transfer; local foreground confirmation completes it when Android or browser permission rules require user activation. Opening, focusing, unlocking, or reconnecting never claims. Exit: claim/return floor, survive background+lock, recover from call interruption, use the same gateway, and never record silently.

### Phase 5 — Rooms and advanced orchestration

Multi-Mate fan-out with moderated floor; Coop subscriptions ("tell me when either reaches a decision"); LiveKit or similar evaluated only from measured needs; iOS from demand.

---

## Acceptance Journeys

1. **Fresh idea** — explore, challenge, plan, amend, hear the diff, approve the exact version, implement, status, verify, close.
2. **Reported issue** — diagnose, explain evidence/confidence, plan, approve, repair, verify, close.
3. **Non-interrupting status** — status during execution changes nothing in the executor queue (executor transcript byte-identical with and without the question).
4. **Minor correction** — "make the icon smaller" is compared with approved intent, queues at a safe boundary, and is narrated in one line without aborting the active turn.
5. **Material correction** — "you missed the point, the flow is…" produces a spoken diff and re-approval; only invalidated work redone.
6. **Still-broken re-entry** — after a done *report*, "didn't work" re-enters diagnosis with context hot; after `CONFIRM_DONE`, `REOPEN_WORK` does the same.
7. **Restart recovery** — browser and daemon restarts resume the same lifecycle, plan version, and floor state (floor re-claimed explicitly).
8. **Cross-device continuation** — begin on web, Continue-here on phone, return.
9. **Coop navigation** — find by topic, disambiguate once, act on a pending decision.
10. **Closeout** — verification evidence spoken, caveats stated, explicit "mark as done".
11. **Pending decision** — executor asks a numbered question; voice resolves the exact pending request and work continues once.
12. **Phase-aware language** — "continue" approves only when a plan is pending, resumes only when paused, and nudges only while working; "ship it" cannot complete work outside verified closeout.
13. **Echo safety** — Clay's own TTS says an approval-like phrase while a plan is pending; no approval operation is emitted.

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
| Device claim | Continue-here | active + old client silent | &lt; 3 s (provisional — Appendix A evidence chooses final budgets) |
| Recovery | connection usable | durable state restored | &lt; 2 s |

Quality: approval correctness (no unapproved version executes — zero tolerance); correction-tier misclassification rate (unsafe minor dispatches are release-blocking; unnecessary clarification is measured as friction); status fidelity vs executor events; false turn-endings; echo loops; duplicate sends; secret-redaction failures (zero); hands-free completion rate per journey; **subscription usage burn and overage** (controller tokens/day, share of usage window, unexpected metered spend = zero for the core); presence-check rate ("alive?" utterances should trend toward zero).

---

## Executable Safety Invariants

Release-blocking automated tests:

1. No executor input, file/repo/runtime mutation, or state-changing external action without a valid approval bound to the current immutable plan version and target.
2. A status request produces zero executor-input events.
3. An approved plan version begins execution at most once.
4. Reconnect, replay, and duplicate delivery cannot repeat an approval, control, permission answer, closeout operation, or intent dispatch.
5. A changed, stale, missing, or ambiguous Coop target receives no routed action; changing visual focus cannot retarget an in-flight utterance.
6. A permission/question answer applies only to its exact still-pending request ID.
7. Executor completion cannot mark lifecycle `complete`; only verified live-human `CONFIRM_DONE` can.
8. Provenance is assigned at trusted server ingress. Client/model claims of `live-human`, machine-injected user-slot events, synthesized speech, replayed audio, TTS echo, and agent-generated text can never approve, confirm done, dispatch repository/runtime work, or answer a destructive confirm (F16).
9. A minor-tier steer never alters plan version, goal, approach, or acceptance criteria records; a material correction cannot execute under the previous approval.
10. Input frames and output chunks are accepted or played only when their `{daemonGeneration, leaseId, epoch}` exactly matches the active floor binding; every pre-restart lease is rejected; owner loss returns the floor to `unclaimed`.
11. Opening, focusing, unlocking, or reconnecting a client cannot claim the floor.
12. Voice-provider failure leaves executor work intact and immediately exposes text transcript and deterministic controls.
13. Secret fixtures never appear in synthesized speech, narration text, persisted snapshots, retained transcripts, or diagnostics; raw recognition containing a fixture remains ephemeral.
14. An amendment cannot approve itself. Approval occurs only after the pending version's diff and identity are presented; the executed plan is byte-identical to that approved version.
15. A claim cannot revoke the old owner before the target is ready and the daemon crosses the atomic commit barrier.
16. New playback cannot begin until old playback is acknowledged stopped or its bounded lease expires; stale buffered chunks fail their local lease check.
17. Every `QUEUE_EXECUTOR_STEER`, `INTERRUPT_AND_STEER`, and `ANSWER_QUESTION` carries a causation chain terminating in a live-human ingress event. A controller proposal with no triggering human utterance is rejected — snapshot- or executor-derived content (which ultimately includes file and web content) can never originate a steer. This is the prompt-injection fence for the executor lane.
18. Conversation invariants bind operations flowing through the conversation gateway (Decision 18). Autonomous sessions outside conversation management are not stranded by Invariant 7; adopting one into a conversation snapshots its state as the baseline intent.

(The v1 list's audio-handoff invariants 10–19 become Phase 3A acceptance criteria — Appendix A.)

---

## Testing Matrix

**Lifecycle**: exploration, diagnosis, plan revision, amendment-diff-approval, execution, pause/continue, verification, ordered closeout; status while working; exact pending question/permission answers; correction before/during/after work; still-broken re-entry ×3 rounds (F6); reload, daemon restart, compaction, provider handoff, stale snapshots.

**Router** (fixtures drawn from the mined corpora — Appendix B): lifecycle matrix for "continue" and "ship it"; every macro phrase incl. typo variants; read-only fuzzy matches; negative collisions ("go"/"no", "ship"/"skip"); fused approvals split into ordered intents; partial approvals; guarded approvals; amendment → pending diff → approval; material markers; short but material scope changes; multi-intent chains; enumeration answers; counter-questions; deferrals; "screenshot coming"; Croatian fragments; conversational agreement that is not approval.

**Coop and routing**: exact/similar/missing/completed/deleted targets; same title across projects; permission-denied target; state change during resolution; rapid focus changes; command spoken during a switch; multiple simultaneous pending decisions.

**Clients and audio**: desktop Chrome, Android Chrome, installed PWA, later native companion; laptop/phone mic-speaker combinations; wired + Bluetooth; route changes while listening/speaking; TTS echo and approval-like playback; barge-in question vs correction; silence for 30+ minutes then resume; suspension/lock/network handoff/incoming call; daemon restart + stale pre-restart frames/chunks + fresh claim; target permission/readiness failure; simultaneous claims; provider timeout and fallback to text.

**Safety**: approval-resembling speech that is not approval; fuzzy state-changing phrases; agent-generated audio and acoustic echo attempting approval; client-forged provenance; untrusted controller JSON shapes; secrets entering inbound transcripts, logs, snapshots, narration, or TTS; replayed controls; old-client audio after handoff; device revocation; stop-speech vs stop-work ambiguity; machine-injected turns attempting gateway ops; Codex fallback attempting file or command writes; executor-derived narration containing adversarial or garbage text that would be *spoken aloud* (speakable-field sanitation fixture); a controller steer proposal with no live-human causation event (Invariant 17).

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

1. Wake/address model: is "Coop" always addressable from a focused session, or only from workspace scope? (Prototype in 3B.) Also validate the **name itself**: "Coop" is one syllable and ASR-collides with cope / coup / co-op / cool / "scoop" fragments — test recognizability with Web Speech during Phase 1, before the name calcifies; a two-syllable name with an uncommon phoneme sequence would false-trigger less.
2. Which events deserve unsolicited narration vs subscription ("tell me when this finishes")?
3. Naming two browser clients on one physical device without unstable identifiers.
4. Tier 1 model sizing: whisper variant (tiny/base/small) and Kokoro vs Piper on the actual daemon hardware — measure WER on his accent + Croatian code-switch (F9) before choosing.
5. How much transcript the Android companion shows without becoming a second UI.
6. Play Store vs internal APK distribution.
7. After both adapters pass read-only and usage-window tests, should controller selection be automatic or user-pinned?
8. Whether "still broken" within N minutes of CONFIRM_DONE should auto-REOPEN_WORK or ask.

---

## Recommended Next Work (in order)

1. **Reliability baseline** — quiet canaries first; conversation correctness is indistinguishable from lifecycle noise without it.
2. **Corpus audit + Phase 0 contract** — complete the privacy-safe evidence table; define runtime event validation, trusted provenance, persistence/replay, phase-aware commands, redaction, echo handling, and minimum safe claims before UI. Note: the audit's labeled utterances double as the **router's test fixtures** (the testing matrix draws from the mined corpora), so it is on the critical path for router testing specifically — not only for percentage claims.
3. **Controller substrate spike** — prove Claude subscription behavior, overage guard, restart, structured proposals, and Codex read-only enforcement. Failure must leave text controls usable and spend at zero.
4. **Macro router + gateway + thin kernel** — deterministic value text-only, including lifecycle-specific "continue"/"ship it", pending questions, pause/continue, amend-readback-approve, and ordered closeout.
5. **Tier 0 audio on the slice** — first end-to-end spoken plan amendment, narrated diff, exact-version approval, echo test, supervision, and closeout on a real task.
6. **Then** Tier 1 local audio, Codex snapshots, and the Phase 2+ ladder.

Do not start with wake words, multi-Mate rooms, a full Android UI, automatic device stealing, playback-offset resume, or broad provider abstraction. Target readiness, atomic claim, and break-before-make output are minimum safety, not optional scope.

---

## Research References

- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — candidate controller substrate; Phase 0 verifies the locally authenticated subscription path and usage behavior rather than assuming a permanent contract
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) / [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — Tier 1 STT
- [Kokoro TTS](https://github.com/hexgrad/kokoro) / [Piper](https://github.com/rhasspy/piper) — Tier 1 TTS
- [Silero VAD](https://github.com/snakers4/silero-vad) — local voice-activity detection
- [Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) — Tier 0 (already in `stt.js`)
- [Deepgram Flux](https://deepgram.com/) · [Cartesia Sonic](https://cartesia.ai/) · [ElevenLabs](https://elevenlabs.io/) — Tier 2 options
- [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime) — evaluated and rejected as foundation (see Voice Architecture Decision)
- Android: [MediaSessionService](https://developer.android.com/media/media3/session/background-playback) · [audio focus](https://developer.android.com/media/optimize/audio-focus) · [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)

---

## Appendix A — Audio-Floor Handoff Protocol

*Status: minimum correctness contract for Phase 3A. Target readiness, atomic commit, input fencing, and break-before-make output are normative. The instrumented prototype chooses budgets and the user-facing speech-resume policy.*

**Two-phase claim transaction**: `requested → target-ready → committing → active`, with `failed / cancelled / expired / failed-after-commit`. Target proves readiness (conversation loaded, permissions granted, playback context usable, media path live, binding unchanged) before an atomic daemon compare-and-swap against the current `{daemonGeneration, leaseId, epoch}`; old owner stays fully active until the irreversible barrier; post-barrier activation failure leaves the floor `unclaimed`, never restoring the old owner or silently activating the target; losing claimants never revoke or activate.

**Input barrier**: stop accepting old-owner frames at a recorded sequence; resolve the old provisional turn exactly once; fragments after the boundary are discarded and marked interrupted; audio from two devices is never spliced into one utterance.

**Output handoff (break-before-make)**: new client starts only after the old client acknowledges revocation or the short playback lease expires; clients flush queued playback on revocation, keep buffers shorter than the lease, and check the lease deadline before playing every chunk.

**Playback-offset resume**: speech segments are numbered; only *actually-played* acknowledgments (not received/buffered) count; after acknowledged handoff resume from the next offset; after partition, wait for lease expiry and speak a short handoff summary instead of guessing.

**Misc**: reconnecting old owners return synchronized-inactive, never auto-restored; pending claims have server-side expiry, are cancellable from either side, and die with their target's disconnect; a newer request from the same user supersedes an older pending one; spoken/system triggers become requests when the platform requires a local gesture ("Continue conversation" button completes them).

**Phase 3A evidence gate**: measure claim request→ready→commit→audio latencies (P50/P95), revocation acknowledgement + lease expiry under partition, mic/playback/suspension/Bluetooth/notification behavior on the real devices, speech-boundary stability and the felt UX of exact-offset resume vs last-phrase replay vs short-summary recovery, and accidental/abandoned/failed claim rates. Evidence chooses budgets and whether playback-offset resume is worth building; it cannot remove the minimum correctness contract above.

---

## Appendix B — Corpus Methodology

**Current source inventory** (mined 2026-07-18):
- Claude primary projects: urban-stay 65 + clay 96 + v2-webapp 264 = **425 sessions**. One additional Trialview-webapp session was inspected separately, for **426 discovered Claude session files** total.
- Codex: **592 rollout files** (~846 MB), with per-file lifecycle parsing, a 420-message stratified sample, and 1,697 agent-final→user-next candidate pairs.

**Current limitations**:
- The Claude manual label file has 367 rows, of which 242 are still `TODO`.
- The 420-row Codex sample preserves extracted tags but does not yet contain the complete behavior labels required to derive every percentage in F5/F8/F12.
- Some sampled Codex rows still contain machine-injected prefixes marked by tags; the final aggregate must exclude them after tagging, not merely claim they were excluded during extraction.
- Temporary working paths under `/tmp/bojan_taxonomy/` and `/tmp/codex_analysis/` are not a reproducible or durable evidence artifact.

Therefore phrase inventories, exact command counts, rare lifecycle events, and broad qualitative patterns may guide prototype coverage now. Manually classified percentages are **provisional hypotheses** until the audit below is complete. No authorization or safety rule may rely on those percentages.

**Privacy-safe audit artifact — required before any percentage is cited as normative, not a blocker for Phase 1 prototype work** (qualitative findings, phrase inventories, and verified counts are sufficient to build the slice; this is a one-user product and the audit's job is honesty, not ceremony):
1. Commit extraction and aggregation scripts without raw private message content.
2. Record source counts, inclusion/exclusion rules, project strata, sampling algorithm, and deterministic seed.
3. Define the behavior taxonomy and double-check ambiguous labels.
4. Finish the samples used for every published percentage and record numerator, denominator, confidence/uncertainty, and representative redacted examples.
5. Produce an F1–F17 evidence table marking each claim `verified-count`, `verified-sample`, `qualitative`, or `hypothesis`.
6. Add a regeneration command and aggregate checks that catch source-count mismatches, injected-message leakage, self-contamination, and unfinished labels.

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
| 2026-07-18 | **v2, refined by v3**: Ground the conversation model in mined session data. Verified counts and qualitative patterns guide the design; unfinished manually labeled percentages remain hypotheses. |
| 2026-07-18 | **v2, refined by v3**: Zero-new-service-spend core through a verified YOKE subscription path plus browser/local audio; guard against overage and require every fallback adapter to pass read-only tests. |
| 2026-07-18 | **v2, superseded by v3**: Barge-in no longer implies steer. It stops speech, then the utterance routes normally; executor interruption is explicit. |
| 2026-07-18 | **v2, superseded by v3**: A spoken amendment creates a pending version and narrated diff; only later approval of that exact version authorizes execution. |
| 2026-07-18 | **v2, refined by v3**: Two-tier corrections remain, but only clearly bounded details queue as minor; uncertain changes fail closed into clarification or re-approval, and stop is not undo. |
| 2026-07-18 | **v2**: Deterministic macro table before any model call (~25% traffic coverage, F11); status answered from snapshot templates at zero tokens. |
| 2026-07-18 | **v2**: Human-input provenance typed on every event; machine-injected turns can never approve/confirm/answer (F16). |
| 2026-07-18 | **v2, refined by v3**: Tier 0 voice remains in the first slice. Cross-device readiness, atomic claim, and break-before-make output remain mandatory; evidence tunes timings and resume UX. |
| 2026-07-18 | **v2, refined by v3**: Limit consecutive blocking questions during execution; exploration asks whether to continue probing instead of applying a universal two-question ceiling. |
| 2026-07-18 | **v2**: Multiplayer voice on one session deferred past Phase 3B; floor scoped per user. |
| 2026-07-18 | **v3**: Phase-aware macro resolution; fuzzy recognition cannot directly authorize state changes. |
| 2026-07-18 | **v3**: Runtime-decode untrusted controller/WS payloads and assign human provenance only at trusted ingress. |
| 2026-07-18 | **v3**: Redact inbound transcripts, persisted snapshots, narration, and TTS output; raw recognition remains ephemeral. |
| 2026-07-18 | **v4**: Steer/answer ops require a live-human causation chain (Invariant 17) — the prompt-injection fence for the executor lane. |
| 2026-07-18 | **v4**: Conversation lifecycle scoped to conversation-managed sessions (Decision 18); autonomous sessions keep automation semantics and may be explicitly adopted. |
| 2026-07-18 | **v4**: Destructive confirms require a consequence-echo answer, never a bare one-syllable yes/no. |
| 2026-07-18 | **v4**: Instant deterministic acknowledgment on brain-path handoff; speakable snapshot fields sanitized before TTS; Tier 0 latency budgets separate concept failure from tier failure; Phase 1 split into 1a text-only / 1b voice sub-gates. |
