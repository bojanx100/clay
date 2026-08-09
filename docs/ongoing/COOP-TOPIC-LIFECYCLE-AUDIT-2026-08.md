# Coop topic lifecycle audit — 2026-08 cleanup

Operational audit of the canonical topic index (`~/.clay/lead/coop-topic-index.json`),
executed under explicit owner authorization to close stale/finished topics without
further approval, with the hard exception that every Webapp topic remains untouched
for later one-by-one owner review. No code was changed; all closes went through the
canonical owner-authorized `coop_topic_close` path (reversible via reopen, membership
and history preserved).

## Evidence bar applied

A topic was closed only when durable evidence proved it finished or owner-instructed
to close: no running/queued/blocked/needs-input linked work, no unresolved owner
decision, no active worker binding, and explicit completion/close evidence. Age,
open status, title, silence, and `unlinked_historical` dispositions were NOT treated
as evidence. Any ambiguity = kept open. Any Webapp classification (ProjectRef,
group, related work, or subject; uncertain = Webapp) = excluded.

Ground facts at audit time:

- 45 topics total: 34 open, 11 merged. All 34 open topics had
  `relatedExecutions: []`; portfolio bindings contained zero topic references —
  no durable topic→task links existed anywhere, so task-state evidence could not
  clear any topic on its own.
- The sole durable owner close-instruction is the owner message at **event index
  40331** in canonical Lead session `871a194b-8879-40f7-a1fe-656e48e722af`
  (file `~/.clay/sessions/-Users-bojansubotic--clay-lead-workspace/871a194b-….jsonl`),
  quoting a close-list: "Close now" = Codex authentication, the "Show me you're
  alive / Listening / Idle" feedback cluster, the original sidebar-controls
  request, and the "Tell me when both mobile things are ready" status topic;
  "Merge then close" = Coop conversation architecture, Chat titles, Uncategorised
  conversations; "Keep open" = mobile switching, topic header, automation policy,
  the cleanup discussion.

## Closed (6) — with evidence

All closes acked `ok=true` via `coop_topic_close`; per-topic membership counts
verified identical before/after (closure changed `status` + `updatedAt` only;
dispositions and the backfill stamp `schemaVersion 1 @ 1786297353549` untouched).

| TopicRef | Title | Group | Evidence |
|---|---|---|---|
| `codex-authentication` | Codex authentication | uncategorised | Owner: "Close now: Codex authentication" at [40331]. Post-40331 member turns are internal markers only, except [53992] — a general progress complaint anchored into this topic, not new Codex-auth work (caveat recorded). 3 incidental "webapp" string hits inside internal fan-in reports are path examples/dedup scenarios, not Webapp subject matter. |
| `auto-a6d8111a175a072cc8558a98` | Why were you idle and why didn't you… | uncategorised | Alive/idle feedback cluster, owner-instructed close at [40331]. Zero genuine owner messages after 40331. |
| `auto-c3511e0c6d19a5f960666e81` | Now we only have listening | uncategorised | Same cluster, owner-instructed at [40331]. Zero owner messages after 40331. |
| `auto-5a516fa658a92e455d641942` | I asked because you reported idle | uncategorised | Same cluster, owner-instructed at [40331]. Zero owner messages after 40331. |
| `auto-ce35aa04133c89ab5193456b` | Resuming After Restart | uncategorised | Contains ZERO owner messages ever — 6 internal restart markers only. Provably a stale artifact topic with no owner subject, no linked work, nothing to decide. |
| `auto-30cd12fbe6d0c9c1d4788a22` | Resuming Interrupted Response | uncategorised | Contains ZERO owner messages ever — 1 internal restart marker only. Same artifact-topic evidence. |

## Kept open — candidates evaluated and declined

| TopicRef | Title | Reason kept |
|---|---|---|
| `auto-55630dc4ad9436c23b2dfe6c` | Tell me when both mobile things are redy… | Owner named it at [40331], but a genuine owner message at [41223] continued sidebar work in this topic AFTER the close instruction → ambiguous → keep. |
| `coop-conversation-architecture` | Coop conversation architecture | Owner said "merge then close" at [40331]; the merge was never executed and heavy later activity continued → not the instructed operation → keep. |
| `auto-e5a4f641af7a3523e89a9aca` | What about chat titles for topics | Same merge-then-close instruction, merge never executed → keep. |
| `uncategorised-conversations` | Uncategorised conversations | Same; also the merge TARGET of 11 merged topics → keep. |
| `auto-eed7195cfa8e693f48a2e350` / `auto-9b915bb2d21b7987586e9268` | "Don't understand this sidebar" / "Is the sidebar ready to be reviewed" | Owner's "original sidebar controls request" mapping between these two is uncertain → keep both. |
| `auto-76ab4c8ad3b3ed3645d23be8` | Lost ability to switch projects on mobile | Owner said keep open at [40331]. |
| `auto-961022f94584224d307f4137` | Now help me to close topics that are… | The active cleanup discussion itself; owner said keep open at [40331]. |
| All remaining open topics | — | No durable completion/acceptance evidence; `unlinked_historical` disposition is explicitly not evidence → keep. |

## Untouched Webapp inventory (for future one-by-one owner review)

| TopicRef | Title | Why classified Webapp |
|---|---|---|
| `webapp-triage-session-cleanup` | Webapp triage session cleanup | group.projectRef = Webapp project `b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9`. |
| `auto-db51d81c7b32b7fa90f4b2c8` | Again, I don't see you working, I see… | Member spans at [45705], [47330] discuss Webapp issues #2503/#2517 → Webapp-related subject (despite being in the alive/idle cluster). |

## Post-closure verification

- Index: 45 topics = 28 open / 6 closed / 11 merged; zero duplicate TopicRefs;
  membership preserved (e.g. codex-authentication keeps all 143 turnRefs/eventRefs);
  index SHA after cleanup `82f18fae6f9dfe2fc9e6e2eab85d01665e7fa6a8`.
- Dispositions and `dispositionBackfill` stamp byte-identical to pre-cleanup values.
- Live projection (`global_coop_projection`): 32 topics (28 open + 4 closed);
  the two "Resuming" topics were already excluded by the pre-existing relevance
  filter before closure, so their absence from the UI is unchanged behavior,
  and their closure is durable in the index.
- Desktop 1440×900: Done section renders "Done (4)", expands to the 4 closed
  topics, selecting closed "Codex authentication" replays its indexed history
  (URL `?coopTopic=codex-authentication`), zero console errors.
- Phone 390×844: 32 rows, "Done (4)", no horizontal overflow, zero console errors.
- No owner data beyond topic lifecycle was mutated; no disposition verbs were sent.
