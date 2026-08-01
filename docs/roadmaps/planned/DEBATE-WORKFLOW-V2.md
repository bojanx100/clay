# Debate Workflow v2

Status: **planned — design agreed with owner 2026-07-31**
Origin: Phase 0 live debate run (findings F-7, F-8 in
`docs/ongoing/PHASE0-HARDENING-AUDIT.md`) plus owner requirements.

## Owner requirements (verbatim intent)

1. AI panelists should use plain language.
2. The user must be able to follow along — pause when the chat gets
   too fast.
3. Raise hand to offer an opinion.
4. No Stop needed in the happy path: a debate ends when it is done, or
   the user raises a hand and says "we're done".
5. It must be clear what makes a debate done and where conclusions
   live.

## What already exists (keep, but make visible)

The engine's bones are right; the failures are affordance failures:

- **Turn boundaries** — moderator → panelist → moderator chaining with
  clean gaps between speakers (`project-debate.js`).
- **Raise hand** — `debate.handRaised` yields the floor to the user at
  the next boundary. Works; unlabeled.
- **Natural conclusion** — a moderator turn with no @mentions is read
  as "wrapping up" and posts a `debate_conclude_confirm` card
  (End / Continue with optional steering text).
- **Resume** — `handleDebateConcludeResponse` accepts
  `action: "continue"` even from `phase: "ended"`.

## Changes

### 1. Plain-language scaffolding (small, server)

Inject into every moderator/panelist context: "Speak plainly. Keep
turns to ~100 words. No jargon unless the topic demands it. Address
one point per turn." `specialRequests` may override per debate.

### 2. Pause (small, server + client)

- `debate.paused` flag; the turn-done handler defers the next
  `triggerPanelist`/`triggerModerator` while paused (turn boundaries
  only — never mid-turn).
- UI: primary **Pause ⏸ / Resume ▸** control; paused banner:
  "Paused — panelists are holding."

### 3. Control relabel + destructive demotion (client, fixes F-8)

- "🖐 Raise hand — get the floor after this speaker"; queued state
  shows "You're next".
- **Stop moves to an overflow menu** with a confirm dialog: "End the
  debate? Panelists' context will be lost." (Destructive-confirm rule,
  Voice roadmap F13.)
- A stopped/ended debate shows "Debate ended — restart with the same
  brief?" reusing the persisted brief (F-8 resume gap).

### 4. Structured conclusion — the missing artifact (server + client)

Today the "conclusion" is the moderator's last turn text, lost in the
transcript; participant digests are private Mate memory, not output.

New: on any natural end (user confirms End, or hand-raise "we're
done"), the moderator gets one mandatory final turn with a fixed
format:

```
RECOMMENDATION: <one paragraph>
KEY ARGUMENTS: <bullets, attributed>
DISSENTS / TRADE-OFFS: <bullets>
OPEN QUESTIONS: <bullets>
```

Persisted as a `debate_conclusion` history entry, rendered as a
pinned card in the session, and exportable (copy / save to file) so a
debate's output can land in a roadmap or issue directly.

`debate_ended` remains the terminal record; a debate that ends via the
overflow Stop records `reason: "user_stopped"` and skips the synthesis
turn (nothing to synthesize from an aborted run).

### 5. Definition of Done (documentation answer)

A debate is **done** when the moderator concludes and the user confirms
(or the user raises a hand and says "we're done", which triggers the
same conclude path). Its output is the `debate_conclusion` entry — the
single place to find results afterwards.

## Non-goals

- No voice integration here (Voice roadmap owns that; Coop can later
  speak the synthesis).
- No changes to the MCP proposal/approval flow beyond what F-6/F-7
  already cover.

## Verification

- A full debate run where: plain language holds, pause/resume works at
  a boundary, hand-raise floor works, natural conclude produces a
  `debate_conclusion` card, and no Stop is needed.
- The Phase 0 §12.3 debate (fixed thresholds vs ratchet) re-run under
  v2 is the natural acceptance test.
