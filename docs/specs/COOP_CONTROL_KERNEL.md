# Coop control kernel

Status: **Slice 1 foundation implemented, default off.**

This slice introduces a narrow SQLite WAL `ControlStore` and a deterministic
shadow importer/comparator. It does not wire the store into the live Coop
owner flow and does not change which existing store is authoritative.

## Boundary

The ControlStore is for durable control-plane facts required by later recovery
slices:

- owner-request references and lifecycle codes;
- canonical coordinator claims;
- privacy-safe shadow digests and mismatch evidence used during migration.

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

The primary exports for later wiring are:

- `createControlStore(options)` / `createCoopControlStore(options)` — gated,
  default-off construction;
- `openControlStore(options)` / `openCoopControlStore(options)` — explicit
  low-level activation for controlled wiring and tests;
- `canonicalProjection`, `canonicalDigest`, `importShadow`, and
  `compareShadow` — deterministic shadow operations;
- `MIGRATIONS`, `LATEST_SCHEMA_VERSION`, and `CONTROL_RECORD_TYPES` — stable
  schema and adapter compatibility constants.

The `attachCoopControlStore` alias exists for the server module convention, but
this slice deliberately does not attach it to an existing Coop module.

## Activation and kill switch

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

The shadow tables are migration evidence, not an authority claim. Making any
SQLite record authoritative requires a later slice with a separately reviewed
read/write cutover.

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
- rejection of topic-index imports.
