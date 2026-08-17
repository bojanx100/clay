# Coop Threads lifecycle

Status: **Approved implementation contract.**

## Purpose and boundary

Coop's owner-facing conversation organization is called **Threads**. A Thread
is a durable, reference-only lens over the canonical Coop transcript. It is
not a session, a task, an execution admission, or a replacement for an
ordinary project's sidebar.

This contract replaces the ambiguous owner-facing word "Topic". Internal
compatibility remains lossless during migration: every existing record retains
its `topicRef: { topicId }` and callers that still read `topicRef`/`topicId`
continue to work. Every migrated and newly-created record also has a stable
`threadRef: { threadId }`. For a migrated legacy record, `threadId` is the
legacy `topicId`; references are aliases to the same durable record, not copies
or redirects that could split provenance.

Thread records and projections contain only durable metadata plus canonical
event and turn references. They must never persist message bodies, assistant
responses, summaries derived from private text, or live data from a daemon.

## Lifecycle model

The only active lifecycle states are:

| State | Meaning | Active discussion list |
| --- | --- | --- |
| `exploring` | The owner is discussing, deciding, or collecting context. | Shown |
| `parked` | Intentionally retained for a reminder, test decision, or later owner action. | Shown in Parked |
| `handed_off` | The owner explicitly sent implementation to a typed project target. | Hidden |
| `closed` | The owner ended the discussion. | Hidden from primary discussion sections |

Closing requires exactly one `closeOutcome`:

- `implemented_resolved` means the owner considers the outcome implemented or
  resolved.
- `not_pursuing` means the owner deliberately will not pursue it.

`Done` is not a primary Threads section. A UI may expose closed records in a
secondary history/filter, labelled by their specific close outcome. A merged
source is not independently displayable; it retains its immutable
`mergedIntoThreadRef` and correction history for audit and transcript routing.

`not_pursuing` is a reversible hide, not deletion. The durable record keeps its
ThreadRef, ProjectRef/group, canonical event and turn references, and lifecycle
history while it is absent from the primary discussion list. Reopen restores
the same record and references.

The migration maps legacy open records to `exploring` unless durable evidence
marks an owner reminder or owner test decision as parked. In particular,
`auto-57ea56ea9f9cc0a4e96cf0f3` and
`auto-ba81bcab5de78c4b5aee2b32` (the #2539 test decision) must become or remain
`parked`, without changing their canonical references.

## Classification and ingress

Every completed canonical owner turn is classified independently from
execution admission:

1. The classifier selects the best matching non-terminal Thread using the
   existing deterministic matching rules and canonical turn evidence.
2. If no match exists and the turn materially introduces a distinct theme, it
   creates one durable Thread identity. Successive distinct themes therefore
   create separate identities.
3. A later related turn reattaches to its best matching existing Thread.
4. A low-information follow-up attaches to the immediately relevant active
   Thread only when canonical context establishes that relationship; it never
   invents execution work.

The classifier returns both compatibility and new forms during the migration:

```js
{
  threadRef: { threadId: "auto-..." },
  topicRef: { topicId: "auto-..." },
  threadState: "exploring",
  lastTurnRef: { projectId, sessionStorageId, startEventIndex, endEventIndex }
}
```

`threadRef`/`threadId` are canonical on new writes. `topicRef`/`topicId` remain
an alias only for backward-compatible consumers. The relationship is one to
one. A classifier may group a Thread with a project for navigation, but that is
not a `ProjectRef` execution admission.

## Owner correction and provenance

The owner can correct automatic classification through three durable,
idempotent operations:

- `reassignTurn(sourceRef, targetRef, turnRef)` moves one referenced canonical
  turn to a target Thread.
- `merge(targetRef, sourceRefs)` merges one or more source Threads into a
  target Thread.
- `undoLastCorrection()` reverses only the newest reversible correction.

Corrections write a bounded correction record with operation identity, before
and after thread references, and canonical turn references. They must not copy
transcript content. Reassignment preserves the source record and a canonical
provenance trail; merging retains all source turn references on the target and
preserves each merged source as a non-displayable redirect/audit record. An
undo restores the exact prior membership and visibility state without creating
new turn identities.

## Explicit implementation boundary and handoff

Theme classification is conversational only. It must never itself admit work,
create a task, claim a coordinator, or attach typed project execution.

An owner must state an explicit implementation decision, such as `build`,
`fix`, `implement`, or `hand this to <project>`. The exact normalizer is
`explicitImplementationDecision(text)`; it returns no decision for ordinary
discussion, questions, analysis, status requests, or a project mention without
an imperative implementation intent.

Only a positive normalized decision may create or attach the typed
`ProjectRef` execution beneath that target project's durable persistent
coordinator. The resulting link contains typed reference identities only. On a
successful handoff the Thread transitions to `handed_off`, remains available as
linked context from project execution, and is removed from active Coop
discussion lists. Execution is displayed beneath the project coordinator, not
duplicated under the Coop Thread.

An invalid, unavailable, or unauthorized ProjectRef fails closed and leaves the
Thread in its prior state. A handoff never creates a project from prose.

## Natural-language lifecycle control

The selected Thread is the command target captured at send time. Clear owner
language such as “keep this open”, “continue the discussion”, “implement this”,
“hand this to Clay”, “request changes: add coverage”, “hide this”, “reopen”, or
“undo that” is admitted only with that exact ThreadRef. The command may resolve
the retained closed projection, but it cannot retarget another Thread or infer a
Thread from the Main lens. Main messages without an exact target remain open to
ordinary conversation and ask which Thread the owner means when clarification
is needed.

The parser is deliberately narrow. Request-changes and implementation/handoff
commands preserve the routed ProjectRef; a repeated reopen or undo is an
idempotent no-op after the first durable application. Lifecycle changes are
recorded as bounded reference-only before/after snapshots, never as a rendered
decision card.

## Projection and UI requirements

Thread projections use owner-facing names and expose at least `threadRef`,
`threadState`, `closeOutcome`, and `lastTurnRef`, while also exposing legacy
`topicRef` until migration consumers are retired. Desktop and mobile render
Exploring and Parked as the primary discussion sections; handed-off and closed
Threads are not duplicate active discussions. Desktop and mobile use the same
navigation-only Thread rows; lifecycle changes are issued in ordinary owner
language from the selected Thread rather than through a resolution card or row
menu.

Ordinary project sidebars retain their existing behavior. Owner-direct sessions
remain direct owner sessions: Coop neither adopts, reroutes, nor nests them
unless the owner explicitly hands them to Coop.

## Migration, safety, and verification

`ensureIndex(index, now)` performs an idempotent in-place schema migration of
the durable topic index. It preserves all known records, event references, turn
references, groups, related execution links, legacy IDs, and existing lifecycle
evidence. It must be safe across restart and concurrent index reloads. It must
not mutate any live daemon ledger or transcript merely by reading/projection.

Focused verification proves: three distinct themes create three Threads; a
later related turn reattaches; legacy aliases survive migration; owner
correction and undo retain canonical provenance; all lifecycle states and close
outcomes project correctly; natural-language lifecycle commands target exact
ThreadRefs, hide reversibly, and remain idempotent; discussion does not admit
execution; explicit handoff creates the expected typed project link and hides
duplicate active discussion; parked reminder and #2539 decision records remain
available; and ordinary sidebar and direct-session behavior does not regress.

## Main-ingress scope repair (2026-08-16)

Every canonical Coop user message carries `coopComposerScope`, captured from
the visible composer lens at send time. `main` and `canonical` are unscoped:
the ingress layer removes all Topic/Thread/Project refs before routing and
skips automatic Thread classification. `topic` keeps its exact TopicRef, while
`project` requires only its ProjectRef. Missing, malformed, or internally
inconsistent scope is rejected rather than inferred from cached selection
state. The same snapshot is carried by reconnect input sync, voice/STT, queued
and scheduled sends.

The repair is applied automatically by the startup migration. There is no owner
message and no daemon restart in the procedure: the owner-gated
`coop_main_ingress_recovery` WebSocket lever has been retired. It was a
pre-admission lever that refused any ingress whose execution was already
admitted, and live ingress 360 now carries an admitted implementation decision
and a coordinator link, so the lever could only ever answer
`execution_already_admitted`. Removing duplicate membership therefore belongs
solely to the startup migration, which alone proves the canonical event
digests.

The migration only accepts ingresses 360, 361, and 362 from source Thread
`auto-cfc74233f22b687493f5efc4`. Before writing, it proves each immutable
canonical user event digest and identity, ambiguity, the matching ledger
request/event reference, turn membership, Project scope, and the absence of
unrelated admitted tasks, sessions, or coordinators. It then creates (or
verifies) exactly one open `Voice` Thread with id
`recovery-voice-ingresses-360-362` and retopics only those turn references and
ledger records. It never rewrites canonical history, source execution links,
or the owner-direct Voice session. A replay succeeds with zero moves and zero
ledger writes; any evidence mismatch fails closed and makes no recovery change.

A handed off target Thread blocks the repair only while it still has to create
that Thread or move a turn into it for the first time. When every remaining
turn already lives in the target, the handoff is the expected state rather
than a conflict: the migration deletes any stale duplicate membership left in
the source, creating nothing, populating nothing, and moving no ledger record.
The target must still be titled `Voice` and be open, and every other proof is
unchanged.

### Applied-first ordering for every finite recovery (2026-08-17)

Each finite recovery in this family (`coop-main-ingress-recovery.js`,
`coop-threads-implementation-recovery.js`,
`coop-urban-stay-autolaunch-recovery.js`,
`coop-urban-stay-policy-recovery.js`) proves immutable evidence — canonical
session identity, event identity, digest, and ambiguity — and then the durable
owner-request ledger record, and returns an idempotent success **before** it
touches any mutable Thread state. Once the ledger carries the admitted
decision the repair is finished, and its output is durable, so closing,
renaming, moving, or releasing the handoff of the Thread it created — the
intended end of that Thread's lifecycle — must return a no-op success rather
than wedge the migration on every later restart. Delegating the same ingress's
work under a different TopicRef through `implementationScope` is downstream
progress and is likewise never re-proven by the applied verdict; the routing
and replay aliases, which grant live authority instead of reporting a finished
write, still require that exact scope. Before the decision is written the
repair must still create or verify the Thread, so mutable drift on that path
keeps failing closed.

The startup registry (`coop-recovered-thread-admission.js`) reports one entry
per migration with `key`, `ok`, `noop`, `terminal`, `code`, and each module's
change flags, so a finished family is legible from a single startup log line
instead of only from the absence of failures. `terminal` marks a failure that
can never self-heal because immutable canonical evidence no longer matches the
pinned fingerprint (digest, event identity, event route or topic, ambiguity);
every other failure — dependencies not loaded yet, persistence, mutable ledger
or Thread drift, an exception — is retryable on a later restart.
