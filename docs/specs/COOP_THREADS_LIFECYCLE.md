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

## Projection and UI requirements

Thread projections use owner-facing names and expose at least `threadRef`,
`threadState`, `closeOutcome`, and `lastTurnRef`, while also exposing legacy
`topicRef` until migration consumers are retired. Desktop and mobile render
Exploring and Parked as the primary discussion sections; handed-off and closed
Threads are not duplicate active discussions. The owner can invoke correction,
state, close, and handoff controls from either layout.

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
outcomes project correctly; discussion does not admit execution; explicit
handoff creates the expected typed project link and hides duplicate active
discussion; parked reminder and #2539 decision records remain available; and
ordinary sidebar and direct-session behavior does not regress.
