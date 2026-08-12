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
