# Coop control kernel

Status: **Slices 1, 2, and 3 implemented, default off.**

Slice 1 introduces a narrow SQLite WAL `ControlStore` and a deterministic
shadow importer/comparator. Slice 2 adds durable logical executions,
incarnations, epochs, role leases, structured authority, a start barrier, and
capability fencing for new Coop-controlled portfolio execution. Existing
owner/topic stores and ordinary sessions remain authoritative and unchanged.
Slice 3 adds monotonic Class A/Class B handoff, immutable transcript-free
continuity checkpoints, permanent stable-message inbox/outbox rows, effect
intent/receipt reconciliation, and a fail-closed startup recovery barrier.

## Boundary

The ControlStore is for durable control-plane facts required by later recovery
slices:

- owner-request references and lifecycle codes;
- canonical coordinator claims;
- privacy-safe shadow digests and mismatch evidence used during migration.
- logical execution identities, physical incarnations, monotonic epochs,
  current role leases, start state, and reference-only authority.
- handoff identities and states, continuity checkpoints, stable delivery
  identities, and visible-effect intents/receipts.

Slice 1 has writable typed schemas only for `owner_request` and
`coordinator_claim`. Approvals, execution bindings, tasks, checkpoints,
handoffs, and learnings are reserved record-type names, but writes fail closed
until their own reviewed schemas land in later slices.

The following stay outside this database:

- topic records and the topic index;
- UI or ACL projections;
- transcripts, prompts, message bodies, and summaries;
- free-form model reasoning;
- ephemeral runtime context.

`topicRef: { topicId }` may appear inside an owner request because it is a pure
identity reference. A topic record, title, membership list, or copied topic
body may not. Each writable type has an exact nested field allowlist, reference
shape, enum vocabulary, identity/key relationship, and set normalization rule.
Unknown fields fail closed. Privacy aliases for topics, projections,
transcripts, prompts, reasoning, messages, history, and runtime context are
rejected even when punctuation or casing changes. The Slice 1 shadow adapter
rejects a topic-index source explicitly.

## Files and compatibility surface

- `lib/coop-control-store-migrations.js` owns the ordered schema.
- `lib/coop-control-store-validation.js` owns the two Slice 1 typed record
  schemas and privacy boundary.
- `lib/coop-control-shadow-validation.js` owns untrusted shadow-envelope
  validation and activation-time logical audits.
- `lib/coop-control-store.js` owns activation, integrity checks, WAL setup,
  transactions, authoritative control-record slots, and shadow evidence rows.
- `lib/coop-control-shadow.js` owns reference-store projection, canonical JSON,
  SHA-256 digests, import, and comparison.
- `lib/coop-control-execution-schema.js` owns the Slice 2 table definitions.
- `lib/coop-control-execution-audit.js` owns execution-state startup audits.
- `lib/coop-control-execution-store.js` is the restricted SQLite operation API.
- `lib/coop-control-executions.js` owns identities, capabilities, transitions,
  and the Slice 2 kill switch.
- `lib/coop-control-execution-completion.js` owns the shared durable terminal
  transition for direct leaves and project coordinators.
- `lib/coop-control-fence.js` and `lib/coop-control-execution-target.js` enforce
  capabilities at the portfolio/provider boundary.
- `lib/coop-control-continuity.js`, `lib/coop-control-continuity-verifier.js`,
  and `lib/coop-control-rehydration.js` own the exact checkpoint schema,
  canonical form, durable-predecessor comparison, privacy boundary, and
  restart restoration.
- `lib/coop-control-recovery-schema.js`, `lib/coop-control-store-recovery.js`,
  `lib/coop-control-store-handoff-rotation.js`, and
  `lib/coop-control-recovery-audit.js` own Slice 3 physical state, restricted
  transactions, restart predecessor rotation, and version-aware startup audits.
- `lib/coop-control-handoff.js` and `lib/coop-control-handoff-target.js` own
  Class A/Class B preparation, durable SessionManager successor evidence,
  cutover, fencing, abort, and roll-forward.
- `lib/coop-control-delivery.js`, `lib/coop-control-delivery-replay.js`, and
  `lib/coop-control-target-recovery-adapter.js` own stable-message delivery,
  bounded target-session replay resolution, and effect reconciliation.
- `lib/coop-control-execution-message.js` owns crash-safe visible application
  and provider resumption for durable execution messages.
- `lib/coop-control-startup.js` owns the recovery barrier and ordered replay.

The primary exports for later wiring are:

- `createControlStore(options)` / `createCoopControlStore(options)` — gated,
  default-off construction;
- `openControlStore(options)` / `openCoopControlStore(options)` — explicit
  low-level activation for controlled wiring and tests;
- `canonicalProjection`, `canonicalDigest`, `importShadow`, and
  `compareShadow` — deterministic shadow operations;
- `MIGRATIONS`, `LATEST_SCHEMA_VERSION`, and `CONTROL_RECORD_TYPES` — stable
  schema and adapter compatibility constants.
- `createHandoffControl`, `createDeliveryControl`, and
  `createStartupRecovery` (plus their `attachCoopControl*` compatibility
  aliases) — gated Slice 3 construction;
- `buildContinuityPacket` and `runTranscriptFreeExam` — deterministic
  continuity and bounded rehydration evidence.

The `attachCoopControlStore` alias exists for the server module convention, but
this slice deliberately does not attach it to an existing Coop module.

## Activation and kill switch

> **Temporary rollback scaffolding:** The legacy execution flow, shadow
> comparison, compatibility flags, and fallback code remain only for the
> activation rollback window. Do not maintain these as permanent dual paths.
> Remove them at the **2026-08-20 (Europe/Zagreb)** checkpoint after the
> activated control path has completed its rollback-window verification.

The supported persistent daemon configuration is `coop.controlKernel` in the
active `daemon.json` or `daemon-dev.json`. When present, it is authoritative
over inherited shell environment for all three flags, including explicit
`false` rollback values:

```json
{
  "coop": {
    "controlKernel": {
      "store": true,
      "executions": true,
      "recovery": true,
      "rollbackScaffoldingRemovalReminder": {
        "id": "coop-control-kernel-remove-rollback-scaffolding-2026-08-20",
        "dueAt": "2026-08-20T09:00:00+02:00",
        "timeZone": "Europe/Zagreb",
        "status": "open"
      }
    }
  }
}
```

Restart through the normal daemon lifecycle after changing this section. To
roll back, set `store`, `executions`, and `recovery` to `false` together, then
restart; partial activation is not supported.

`createControlStore()` activates only when one of these is true:

```text
options.enabled === true
CLAY_COOP_CONTROL_STORE=1
```

An explicit `options.enabled === false` wins over the environment and is the
kill switch. With the flag absent or false, construction returns a disabled
adapter: it does not create a directory or database, does not enumerate shadow
sources, and does not invoke transaction callbacks. Since no live module is
wired in Slice 1, ordinary Coop behaviour remains unchanged while the flag is
off.

Slice 2 requires both flags:

```text
CLAY_COOP_CONTROL_STORE=1
CLAY_COOP_CONTROL_EXECUTIONS=1
```

`options.enabled === false` is the programmatic Slice 2 kill switch. With the
second flag absent, the portfolio target and SDK/provider bridge take their
pre-existing paths and no SQLite file is opened. Activation is evaluated at
daemon startup; changing either environment variable requires a restart.

Slice 3 requires all three flags:

```text
CLAY_COOP_CONTROL_STORE=1
CLAY_COOP_CONTROL_EXECUTIONS=1
CLAY_COOP_CONTROL_RECOVERY=1
```

An explicit `options.enabled === false` is the programmatic Slice 3 kill
switch. With the recovery flag absent, handoff and delivery adapters perform no
filesystem I/O, the startup barrier is a pass-through, and the portfolio
message path keeps its legacy behaviour. With the flag present, controlled
portfolio intake fails closed until validation and replay open the startup
barrier.

`openControlStore()` intentionally bypasses the flag. It is the explicit API
for tests and for a future wiring point that has already evaluated authority
and rollout policy.

## SQLite and failure policy

Activation requires `node:sqlite`. There is no JSON, in-memory, or third-party
fallback. A runtime without `node:sqlite` receives
`COOP_CONTROL_STORE_UNAVAILABLE`; disabled mode remains safe on that runtime.
Clay currently supports Node 20, while `node:sqlite` is only present in newer
Node releases, so the feature must remain off on runtimes that do not expose
the module.

On activation the store:

1. opens the exact configured database path without replacing it;
2. runs `PRAGMA integrity_check` before any schema migration;
3. rejects nonempty version-zero databases and validates the exact supported
   schema objects, column declarations, affinities, `NOT NULL` flags, primary
   keys, checks, indexes, foreign keys, and `STRICT` declarations;
4. audits migration metadata and every existing typed control row before any
   migration can modify the database;
5. creates a consistent `VACUUM INTO` backup before migrating an existing
   database;
6. applies ordered, individually atomic migrations and records their exact
   version/name sequence;
7. reruns integrity, `foreign_key_check`, and logical audits across control
   rows, shadow rows, canonical JSON, row digests, import counts, projection
   digests, timestamps, and parent/child consistency;
8. requires `journal_mode=wal`;
9. uses `BEGIN IMMEDIATE` transactions and rolls back the complete transaction
   on callback, injected pre-commit, or SQLite commit failure.

Unreadable, corrupt, too-new, or structurally inconsistent databases fail
closed. They are never renamed, truncated, deleted, or interpreted as empty.
Activation performs all fail-closed validation before returning a handle, and
schema/logical rejection does not rewrite the original database.

## Schema

Migration 1 creates:

- `coop_control_migrations` — exact ordered migration history;
- `coop_control_records` — versioned canonical JSON control records keyed by
  `(record_type, record_key)`.

Migration 2 creates:

- `coop_control_shadow_imports` — one projection digest/count/timestamp per
  source namespace;
- `coop_control_shadow_records` — canonical, per-record digests used to produce
  bounded mismatch evidence.

Migration 3 creates:

- `coop_control_authorities` — reference-only source, binding revision, target,
  role, and fixed action mask;
- `coop_control_executions` — stable logical identity and monotonic epoch;
- `coop_control_incarnations` — physical attempt, bound `SessionRef`, capability
  verifier, and start-barrier state;
- `coop_control_role_leases` — exactly one active role holder per execution.

Migration 4 creates:

- `coop_control_handoffs` — deterministic handoff identity, immutable class,
  predecessor/successor refs and epochs, monotonic state, audited durable
  Class B successor-creation receipt, and audit codes;
- `coop_control_checkpoints` — one immutable canonical continuity packet per
  handoff, with its verified SHA-256 digest;
- `coop_control_outbox` / `coop_control_inbox` — permanent stable-message
  identities, delivery attempts, and acknowledgements beyond any bounded dedup
  window;
- `coop_control_effects` — one stable visible-effect intent per accepted inbox
  message plus its durable receipt.

Migration 5 creates:

- `coop_control_delivery_payloads` — one bounded actionable delivery reference
  per outbox/inbox identity; it never copies text, prompts, transcripts, or
  runtime context;
- `coop_control_successor_receipts` — exact SessionManager creation evidence
  for a Class B preallocated successor before it can be marked created.

The shadow tables are migration evidence, not an authority claim. Making any
SQLite record authoritative requires a later slice with a separately reviewed
read/write cutover.

## Slice 2 execution protocol

Only new `portfolio_execution_create` work is controlled. The portfolio task,
binding revision, target `ProjectRef`, and execution mode deterministically
derive a stable `executionId`. Each retry receives a random `incarnationId`, a
strictly increasing epoch, and a process-memory capability secret. SQLite holds
only its SHA-256 verifier. The secret is never serialized into the session,
transcript, task graph, or ControlStore inspection result.

Start is ordered and fail-closed:

1. atomically persist authority, logical execution, reserved incarnation, and
   its sole role lease;
2. create the physical Clay session;
3. bind its stable `SessionRef` to the incarnation;
4. persist the open start barrier (`ready`);
5. assert the captured capability before provider construction;
6. mark `started` after the provider handle is returned and before sending the
   first message.

Fault injection covers every boundary. A commit failure leaves no rows or
session. A failure after reservation, binding, barrier opening, or provider
construction yields no unfenced provider message and terminalizes immediately,
or is terminalized by startup recovery when the process died before cleanup.
New sessions that fail before their first provider message are removed from the
live session map; coordinator sessions that predate the execution are retained
with a terminal failure so a retry can reuse the same visible coordinator.
Startup recovery never resumes an in-memory secret: it releases every
incomplete lease, marks that incarnation failed, and a replay advances the
same logical execution to the next epoch.

When a crash separates the durable terminal transition from the legacy session
file update, restart reconciliation treats the ControlStore as authoritative.
A durably completed incarnation is projected back to `completed` and its typed
completion is redelivered idempotently; incomplete incarnations are failed by
the startup barrier before their session projection is reconciled.

The capability fence is checked for `provider_start`, provider callbacks,
tool authorization/calls, progress, and completion. The check binds all of
`executionId`, `incarnationId`, epoch, role, authority id, capability verifier,
and current lease. Advancing an epoch or releasing a lease makes every old
category fail with `COOP_CONTROL_FENCE_REJECTED` before its mutation or effect.
Unknown actions fail with `COOP_CONTROL_AUTHORITY_DENIED`. Provider callbacks
capture the fence for the specific query, so a later incarnation cannot lend
authority to an older stream.

Verified project-coordinator completion commits through that captured fence
before its legacy session projection is marked complete or archived, releasing
the sole role lease durably. Late provider-start promises and watchdog timers
also verify their captured incarnation before mutating session state, so an
older turn cannot fail or abort its successor.

Authority is an exact structured object: canonical Coop source `SessionRef`,
portfolio task id, positive binding revision, target `ProjectRef`, execution
mode/role, and the fixed five-action mask. Unknown fields, prose aliases,
invalid refs, role escalation, and idempotency conflicts fail closed. Topics,
objectives, acceptance text, owned paths, prompts, and transcripts never enter
these tables.

## Slice 3 recovery protocol

Slice 3 distinguishes two operations. Class A changes an unhealthy provider
route while retaining the visible `SessionRef`. It still advances the physical
incarnation and epoch, so callbacks from the prior provider are stale. Class B
replaces unhealthy context with exactly one preallocated successor
`SessionRef`; replaying its deterministic `handoffId` returns that same
successor instead of creating another session.

Preparation atomically persists the handoff and its immutable continuity
checkpoint while the predecessor still holds its lease. A Class B successor is
created idempotently through the target `SessionManager` against the
preallocated ref. Its saved exact `SessionRef` and deterministic receipt are
registered and verified before it can be marked created.
Cutover is one transaction:
the predecessor incarnation becomes failed/superseded, the successor
incarnation becomes ready, the epoch advances, and the sole role lease moves.
An explicit live abort may leave the predecessor unchanged. After a process
restart, a prepared handoff instead rotates a fresh fenced incarnation onto
the same predecessor `SessionRef`, restores continuity, and reactivates it
before recording the abort. A receipted inactive Class B preallocation is
deleted or hidden only when its session-file marker exactly matches that
handoff and receipt. Cutover is the point
of no return: later failure cannot transfer authority back and can only advance
again to a fresh fenced incarnation bound to the same chosen successor ref.

The continuity packet has an exact allowlist and deterministic identity order.
It preserves admitted objectives, accepted decisions, unanswered owner-request
identities, task ownership/status, execution bindings, structured authorities,
explicit logical execution cross-links, and learning-reference placeholders.
Task and binding status values are lossless canonical-store codes; bindings are
identified by `(portfolioTaskId, bindingRevision)`, not task id alone. Every
execution must exactly link its task, binding revision, mode/role, target,
authority id, and canonical Lead source. Topic data, projections, transcripts,
messages, prompts, hidden reasoning, conversation history, summaries, and
runtime context are rejected. Startup reparses and canonicalizes every packet;
digest mismatch or schema/privacy drift is logical corruption, never empty
state.
Every collection is bounded at 256 records and the canonical packet is bounded
at 131072 UTF-8 bytes. The status allowlists are null-prototype own-property
maps, so inherited names such as `constructor` and `toString` are never valid.
An `unrouted` binding is the single exact binding state allowed to omit both
authority and execution; routed states retain complete cross-links.

Stable delivery no longer relies on the legacy 64-command session window. The
permanent inbox primary key makes acceptance logically exactly once for a
stable `messageId`. Inbox acceptance and its visible-effect intent commit in
one transaction alongside one bounded payload reference. Execution-message
text is resolved from the bounded target-session replay record by that stable
reference; an unavailable, identity-mismatched, or digest-mismatched record
fails closed. Each message kind has one allowed effect kind and the effect
target must exactly equal the envelope recipient, both at live acceptance and
startup audit. Startup reads intended effects through one joined pending query
and makes one row pass without per-effect inbox lookups or redundant full
scans. Reconciliation always supplies the same `effectId` to the
idempotent executor; the receipt commits only after the effect returns. A crash
between the visible effect and receipt therefore reuses the same identity and
cannot create a second visible action.

Direct execution-message content is saved before inbox/effect intent in a
bounded target-session replay record, never in ControlStore. The record binds
the exact message, payload reference, SHA-256 digest, effect id, and target
`SessionRef`. This boundary uses an acknowledged durable session save that
bypasses heavy-save coalescing and propagates write failure before any SQLite
intent can commit. Class B successor preallocation uses the same acknowledged
save before recording its creation receipt. Recovery resolves and reapplies it under that identity; cleanup
requires a durable effect receipt and, when present, an acknowledged outbox.

On startup the recovery barrier remains closed while the store runs physical
and logical audits, classifies every recoverable handoff before generic cleanup,
terminalizes incomplete non-handoff executions, rotates and reactivates
pre-cutover predecessors on their same visible refs,
rolls post-cutover handoffs forward, replays pending outbox messages,
reconciles intended effects, and repeats this serialized pass until no
recoverable handoff, pending outbox, or intended effect remains. Runtime target
handlers for rehydration, activation, delivery, and effect receipt are wired
before this loop begins, but recovery itself starts only after the target
SessionManager has its durable project identity. A process-wide registry routes
each recovery operation by target `ProjectRef`; an unregistered target keeps
the barrier closed and a later project registration retries the same durable
work. Synchronously loaded projects register during one daemon turn, and one
deferred process recovery pass begins only after that registration batch.
An effect whose visible history append survived a crash still resumes its
provider under the rotated fence; history presence alone is never accepted as
provider-start evidence. Asynchronous effect application remains part of the
closed barrier and commits its receipt only after provider evidence resolves.
Recovery/handoff provider-start failures retain the current lease and
handoff row for the next roll-forward, while ordinary starts keep their
terminal cleanup behavior. Rehydration derives one deterministic bounded
provider input from all continuity categories at runtime without storing that
input in SQLite. Controlled orchestration intake
checks the still-closed barrier until asynchronous provider-start evidence has
completed. Any
missing activation/delivery/rehydration handler, pending acknowledgement, or
corruption leaves the barrier closed. Controlled orchestration intake checks
this barrier before applying commands; ordinary flag-off traffic does not.

## Canonical Coop incarnation controls

The permanent canonical Coop `SessionRef` has an independent model-context
incarnation epoch. Owner-only **Restart**, **Switch model**, and **Switch
provider** actions rotate that epoch and use the shared provider switch
executor with a forced fresh context. Restart preserves the current exact
provider route and model. Model switching preserves the provider route and
requires the selected model to be the applied model. Provider switching
requires both the selected route and model to be applied. None of these actions
restarts the Clay daemon.

Rotation preserves the Coop session, durable transcript, owner ingress lane,
topics, owner-request backlog, queued messages, scheduled messages, and
outstanding execution references. Every provider query captures the current
incarnation capability. After rotation, callbacks from the prior query fail the
same fence used for controlled execution before they can mutate history, run a
tool, report progress, or complete. A switch that fails before exact target
verification restores the previous route, model, native provider ids, history
boundary, tombstone, and incarnation metadata; the prior capability remains
current so the existing Coop can recover.

The responsive Coop configuration panel is one DOM surface shared by desktop
and mobile. It exposes the exact Restart, Switch model, and Switch provider
controls only for the canonical Lead session. Confirmation uses Clay's custom
dialog surface. Results return as typed `coop_incarnation_result` messages.

## Durable project and task coordinator hierarchy

Each canonical `ProjectRef` owns one durable reusable project coordinator
`SessionRef` in the Lead/Coop project. Its control-plane policy carries the
explicit target `ProjectRef`; it is a persistent hierarchy root, not a bounded
target-project execution attempt. Council and Triage are persistent peer
sessions in the same control plane.

Every admitted project binding creates or reuses a top-level task coordinator
in the target project. The create envelope is sourced by the matching
Lead-resident project coordinator, never by canonical Coop or a synthetic
target-local root. Workers and reviewers are owned by that task coordinator.
The binding stores the target task-coordinator ref and the stable Lead
project-coordinator ref so restart/recovery reconstructs the authority chain.

Coop projects this as project coordinator → task coordinators → workers and
reviewers. Actual project sidebars omit the persistent root and show the same
task coordinators and sessions whether Lead mode is on or off. Selecting a node
performs ACL-checked SessionRef resolution; it never copies transcripts,
creates a Lead-local project executor, or adopts owner-direct sessions.

## Deterministic shadow comparison

Slice 1 imports the existing `clay.coop_owner_requests` reference-only store.
It projects only validated owner-request and coordinator-claim control fields.
Outcome summaries, transcript-like fields, unknown prose, and all topic-index
records are excluded.

Canonicalization sorts object keys, source records, coordinator claims, and
set-like reference arrays. Equivalent inputs therefore produce the same JSON
and SHA-256 digest regardless of source enumeration order. Duplicate identical
records collapse; duplicate identities with different content fail with
`COOP_CONTROL_SHADOW_CONFLICT`.

Prebuilt/direct projections are not trusted canonical input. They pass through
the same per-type normalization, exact record wrapper checks, set sorting,
identity/key validation, conflict detection, and privacy boundary as projected
reference-store rows. Shadow replacement separately validates its exact
digest/record envelope before touching SQLite.

Re-importing an identical projection is a true no-op: shadow rows and the
original `importedAt` remain unchanged. Equality comparison and replacement run
inside one `BEGIN IMMEDIATE` transaction, so concurrent identical imports have
one `changed: true` winner and preserve that first timestamp. Comparison
returns only typed mismatch codes, record identities, counts, and
expected/actual digests. Corrupt metadata can never produce `match: true`, and
comparison never returns copied payloads.

### Compatibility with the adjacent owner ledger

The reference-only ledger bounds some fields by length alone, so the projection
has to accept every value that ledger accepts without either aborting or
admitting prose. Aborting is the worse failure: one degraded row must not remove
every other row from the comparison.

- `ingressSequence` `0` is the ledger's canonical "unknown sequence" sentinel.
  It projects and compares as `0`; only negative or non-integer values are
  rejected.
- `response.supersededBy` carries a bounded control code (`owner_interrupt`, or
  a caller reason the ledger caps at 40 characters), never an ingress id. Values
  that are single bounded codes survive byte-for-byte, because they are the only
  evidence distinguishing one superseded request from another; a caller reason
  that is not a bounded code takes the same stand-in as the fields below.
- `outcome.status` (40 characters) and `classification.source` (64) are
  length-bounded but not identifier-bounded by the ledger. When either is not a
  bounded code it projects as a `noncode.`-prefixed stand-in over the rejected
  value: deterministic, stable across runs, distinct for distinct values, and
  revealing nothing readable. Direct writable validation stays strict — a
  non-code `outcome.status` or `classification.source` written straight into the
  store is still rejected with `COOP_CONTROL_STORE_INVALID_RECORD`.

The stand-in spends the field's entire remaining budget on digest rather than a
fixed short prefix, so it is as collision-resistant as the bound allows: the
8-character prefix leaves 32 hex characters (128 bits) at a 40-character bound
and 56 (224 bits) at 64. A genuinely empty value still projects as `""`, so
"absent" stays distinguishable from "not representable".

`attention` is the one code-shaped field that needs no stand-in: it is closed
over a fixed reason vocabulary by `coop-work-activity.normalizeAttentionCode`,
which maps anything unrecognised to `attention_required` before the projection
sees it. Its `CODE_RE` guard is therefore defense-in-depth, not a live path.

Stored shadow rows are untrusted once the store is open, because a row can be
corrupted underneath a live process. Comparison therefore never re-normalizes
stored rows into the shadow digest, and a row whose JSON still parses but whose
typed schema or canonical form fails is reported as a `shadow_record_invalid`
mismatch rather than thrown. Evidence repeats only values that pass their own
typed bound — record type, record key, counts, and SHA-256 digests — so a
corrupt field name, validator message, or payload can never travel back to the
caller. Activation still fails closed on the same corruption: reopening the
store raises `COOP_CONTROL_STORE_LOGICAL_CORRUPTION`.

Metadata counts are checked twice, because they fail for different reasons.
`shadow_record_count_mismatch` means the recorded count disagrees with the
expected source count, so the import is stale. `shadow_stored_count_divergence`
means the recorded count disagrees with its own stored rows, so rows were added
or dropped underneath the import.

The complete mismatch vocabulary comparison can return:

| Code | Meaning |
| --- | --- |
| `missing_shadow_record` | The source projects a record the store does not hold. |
| `unexpected_shadow_record` | The store holds a record the source does not project. |
| `record_digest_mismatch` | Both sides hold the identity, with different content. |
| `shadow_record_invalid` | A stored row parses but fails its typed schema or canonical form. |
| `shadow_import_missing` | Shadow rows are being compared with no import metadata. |
| `shadow_record_count_mismatch` | Metadata count disagrees with the expected source count. |
| `shadow_stored_count_divergence` | Metadata count disagrees with its own stored rows. |
| `projection_digest_mismatch` | Metadata digest disagrees with the stored rows' digest. |

Every entry carries the same bounded shape: `code`, `recordType`, `recordKey`,
`expectedDigest`, `actualDigest`, plus `expectedCount`/`actualCount` on the two
count codes. Any field that fails its own bound is reported as `""` or `null`
rather than echoed.

### Strict-input boundaries that stay fail-closed

Compatibility does not mean accepting everything the ledger accepts. Two
ledger-accepted values are intentionally rejected rather than degraded, because
the projection would have to invent meaning it cannot substantiate:

- negative `receivedAt`/`updatedAt`: the ledger's `finite()` accepts any finite
  number, while the typed schema requires `>= 0`. There is no honest projection
  of a negative timestamp — unlike `ingressSequence`, there is no sentinel the
  ledger reserves for "unknown" — so it fails closed with
  `COOP_CONTROL_STORE_INVALID_RECORD`.
- prose `topicRef.topicId`: `coop-topic-ref.normalizeTopicRefInput` accepts any
  non-empty trimmed string, while the typed schema requires a bounded
  identifier. A stand-in is deliberately *not* used here: topic content is
  explicitly out of ControlStore scope, so a digest of a prose topic id would
  smuggle a topic-content shadow past the privacy boundary the rest of this
  slice enforces. Relaxing it is a routing decision on the separately owned
  topic-flow surface, not a local change.

The distinction is whether the adjacent ledger's value carries meaning the
projection can represent. A bounded code does, and a reserved sentinel does; an
out-of-range timestamp and an unbounded topic identifier do not.

Transaction callback capabilities are active only during the synchronous
callback phase. Captured methods fail with
`COOP_CONTROL_STORE_TRANSACTION_CLOSED` after return, throw, rollback, or a
rejected async callback; async transaction callbacks are unsupported.

## Slice 1 verification

The focused tests cover:

- default-off and explicit kill-switch behaviour;
- explicit `node:sqlite` availability failure;
- WAL mode and ordered migrations;
- backup contents before migration;
- fail-closed corrupt-state handling;
- exact schema and stored logical-state rejection without mutation;
- rollback under injected commit failure;
- canonical digest stability across shuffled equivalent input;
- direct-projection normalization, conflict, key, and privacy rejection;
- idempotent file-backed shadow import;
- concurrent import single-winner behavior;
- bounded typed mismatch evidence for corrupt counts and digests;
- rejection of topic-index imports;
- corrupt stored payloads and identities comparing as bounded mismatches while
  activation still fails closed;
- idempotent import and comparison of `ingressSequence` `0`;
- byte-exact survival of bounded `supersededBy` control values;
- deterministic, prose-free projection of a non-code `outcome.status` and
  `classification.source` — including full-width stand-ins and preserved empty
  values — alongside strict rejection of the same values on a direct write;
- metadata counts compared against both the source count and the stored rows.

## Slice 3 verification

Focused tests cover Class A `SessionRef` retention, Class B singleton
successors, every injected handoff boundary, pre-cutover abort, post-cutover
roll-forward, stale capability rejection, durable predecessor/canonical-binding
comparison, bounded continuity survival across reopen, privacy-field rejection,
permanent dedup beyond 64 message ids, durable delivery-reference replay,
effect crash reconciliation, asynchronous startup-barrier ordering, joined
effect-query scaling, exact migration/schema validation, fail-closed checkpoint
corruption, and strict flag-off compatibility.
