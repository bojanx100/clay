# 2026-09-03 — Codex catalog staleness was seed poisoning; "orphan tool_result" is not real

Task `clay-fix-codex-model-cache-and-orphan-tool-results-20260828` (revision 3;
revisions 1-2 never ran) was commissioned against two symptoms:

1. stale Codex model catalogs forcing "last-known-good + exact-probe" fallback
   chains during failovers, and
2. orphaned `tool_result` events accumulating in session transcripts.

**Symptom 1 was real, and its cause was not staleness.** **Symptom 2 does not
reproduce — do not chase it again.** Details and evidence below.

## 1. Symptom 1: the fallback chain was the immune response, not the disease

The last-known-good cache and exact-probe chain were not the problem; they were
what a poisoned cache forced everything else to work around.

`lib/yoke/adapters/codex.js` substitutes `codexModels.fallbackCodexModels()` —
the hardcoded 7-model seed table — for `_cachedModels` whenever `model/list`
fails, and the substitution was **invisible in the shape it returned**. Four
paths leaked the seed indistinguishably from a live catalog: construction,
`clearRuntimeState()`, the post-`model/list`-failure branch, and
`supportedModels()`.

`lib/sdk-bridge-vendor-readiness.js` then persisted whatever it was handed via
`modelCatalogCache.applyDiscovery()`. Because every seed entry carries a
concrete `value`, `isAuthoritative()` returned true, so `rememberModels()`
stored the seed and stamped it `provenance: "live-discovery"` unconditionally.

Two consequences, both reproduced by executing the real modules (not by
reading):

- One failed `model/list` permanently replaced a real catalog and dropped every
  model the seed does not name — precisely the
  just-released-model-missing-from-the-picker failure `model-catalog-cache.js`
  exists to prevent.
- The forged provenance defeated the **purpose-built** fail-closed seed check in
  `lib/provider-routes.js` `verifiedNativeCatalog`, which only fires when
  `provenance !== "live-discovery" && looksLikeStaticCodexSeed(models)`. It also
  marked the route catalog `verified: true, source: "live-initialization"`.

Fixed in three layers (commit `dc79a534f0`): honest `_modelsProvenance` at the
source, threaded through readiness, plus a **mechanical identity check** in the
cache that refuses the seed regardless of what the caller claims about
provenance. Declining is provably safe: a list whose concrete values are exactly
the seed's carries no information the cold-start seed does not already provide.

**A TTL was deliberately NOT added.** `savedAt`/`verifiedAt` are written and
never read, which looks like a missing-expiry bug but is not the cause here.
Expiring a last-known-good catalog would discard it exactly when it is most
needed (offline, failed fetch, startup race), which is the opposite of the
point. Poisoning was the cause; expiry would not have fixed it.

Also retracted in place: `test/provider-routes.test.js` asserted "explicit
live-discovery provenance supersedes fallback-set equality" — the exact trust
that enabled the bug — and **could not have failed anyway**, because
`richLiveModels` is derived from `fallbackCodexModels()` so both sides of the
length comparison were 7 either way.

## 2. Symptom 2: orphaned `tool_result` in transcripts does not exist

Checked every emitter and the whole persistence path. A `tool_result` with no
preceding `tool_start` for the same id is **not producible**:

- Every Codex emitter synthesizes `tool_start` (+`tool_executing`) in the *same
  function call*, before pushing `tool_result`, behind an
  `if (!state.toolBlocks[item.id])` guard — `codex-events.js:297/333/371`,
  `codex-image-events.js:65/102`, `codex-rich-events.js:44/139`,
  `acp-event-normalizer.js:96`. This holds even when `item/completed` is the
  first notification ever seen for that id.
- All paths key `toolId` and the `state.toolBlocks` lookup off the same
  `item.id`; there is no start-uses-blockId / result-uses-toolId mismatch.
- `session.sentToolResults` is bounded, not a leak: reset on `turn_start`
  (`sdk-message-processor.js:575`) and again on `result` (line 846).
- History is strictly append-only (`sessions-io.js:52`), with no reordering.

`releaseTools` in `sdk-bridge-stream-watchdog.js:105-121` is a *different,
already-fixed* concern — it zeroes the in-memory `_activeProviderToolCount` and
never touches `session.history`. Do not confuse the two.

## 3. The inverse defect is real but inert — deliberately not fixed

The failure that *does* occur is the mirror image: a **dangling `tool_start`
with no result**. Once `state.aborted` is set, `codex.js:222` drops every
notification except `turn/completed`, `turn/failed`, `serverRequest/resolved`,
`thread/status/changed`, so an in-flight tool's `item/completed` never arrives
and its `tool_result` is never synthesized.

**It is not user-visible, and nothing depends on the pairing:**

- Abort unwinds to `interruptedStreamEnd` (`sdk-bridge-stream-events.js:179-186`),
  which records a `done` entry. On both live and replay, `done` drives
  `markAllToolsDone()` (`tools-results.js:397-433`), flipping every open tool to
  a terminal "Stopped" state. `handleHistoryDone`
  (`app-messages-history.js:90`) is a second backstop. No stuck spinner.
- `handoff-context.js:158` uses `tool_start` **only** to populate an
  `activeTools` name-lookup entry and pushes no block, so a dangling start
  contributes nothing to handoff output; `describeToolResult` already tolerates
  unmatched ids.
- `coop-topic-relevance.js:93` classifies `tool_start`/`tool_result` as
  operational and filters both out wholesale.
- `project-workspace.js:130` and `project-filesystem.js:394` skip these types
  during text scans.

So the residue is cosmetic (checkmark instead of an interrupted marker, no
output body) with no downstream consumer. Given that, plus near-daily churn from
other agents on every candidate file (`codex.js` had a commit land the same
day), it was left unfixed rather than risking a contended abort path for a
cosmetic gain.

Note also that relaxing the `codex.js:222` filter would **not** work on its own:
`pushEvent`'s `if (iteratorDone) return;` gate (line 133) already discards
post-abort events, since `endIterator()` sets `iteratorDone` synchronously at
abort time. The `bbdd14631d` interrupt-drain keeps the event subscription alive
for turn-level bookkeeping only; it was never wired to redeliver tool events.
If this is ever worth fixing, the safe hook is `finishStream`
(`sdk-bridge-stream.js:16-25`), which still holds the exact open-tool id set in
`state.activeTools` and has `sendAndRecord` in scope — additive to
`releaseTools`, whose counter reset is load-bearing for the daemon-restart drain
and the execution reaper.

## 4. Unrelated defect found and fixed on the way

`lib/clay-history-mcp-server.js` rendered `tool_result` through the
`tool_executing` branch, reading `entry.name`/`entry.input` — fields a recorded
`tool_result` (`{ type, id, content, is_error }`) does not have. Every tool
result in a `read_session` transcript came back as a contentless `[TOOL] ` line
with the output dropped: a result that *looked* orphaned to any reader of that
tool, which is plausibly how symptom 2 was observed in the first place. Fixed in
commit `0647af3b50`.

## Verification standard used

Both fixes were proved by reverting them with the tests kept: symptom-1 source
reverted → 12 pass / 5 fail, restored → 17/17; the render fix extracted with the
defect intact → 2 pass / 3 fail, fixed → 5/5.

**RETRACTED (same day, corrected below):** this section first reported a
full-suite comparison of "fix = 25 fail / 14 files vs clean `origin/bojan`
baseline = 26 fail / 15 files". Those numbers are inflated and should not be
cited. Both runs were in `/tmp` worktrees with no `node_modules`, so 11 of the
failures were missing-dependency noise, not test failures. A `git worktree add`
does **not** get you `node_modules`; symlink the main checkout's copy before
running anything (see also commit `80f783fee9`, where another agent hit this).

Corrected numbers, with dependencies present: **3709 tests, 14 fail across 5
files**, identical to the pre-change baseline on the same 5 files
(`coop-control-store`, `coop-thread-execution-admission`, `lazy-session-history`,
`project-connection-orchestration`, `project-task-orchestrator-external`) — all
pre-existing and none attributable to this work. Codex/catalog suites: 72/72.
`yoke-adapter-contract` and `codex-models-cache` pass once deps exist; their
earlier failures were purely environmental.

**RETRACTED (same day):** this section also claimed "no live Codex app-server
was driven through a real `model/list` failure, so the failover is verified at
the readiness seam, not end-to-end". That limitation was real when written but
has since been closed — see below. Do not repeat the claim.

## The real init() path IS covered — and how

`lib/yoke/adapters/codex.js` destructures `CodexAppServer` at module load
(`var { CodexAppServer } = require("../codex-app-server");`), so installing a
fake in `require.cache` for that module *before* codex.js loads is the entire
injection. `test/codex-init-seed-substitution-e2e.test.js` (commit
`195009cffa`) uses this to run the genuine `init()` path in-process: no codex
binary spawned, no network call. The fake needs only
`start`/`send`/`notify`/`started`. Confirmed genuine rather than stubbed by the
production log line firing: `[codex] model/list failed, using fallback models`.

**Hazard worth knowing before reusing this:** `init()` calls
`migrateModelsCache` against the real per-user `~/.codex/models_cache.json`, and
that call **can write**. Set `process.env.CODEX_HOME` to an empty temp dir first
(an absent file makes the migration a no-op) and use
`test/helpers/isolated-clay-home` for `~/.clay`. Without both, an innocent-looking
adapter test edits live state.

## The two protection layers are independent — neither is load-bearing alone

Breaking each layer separately (rather than only reverting everything at once)
is what shows this, and it is the most useful thing to know if you touch this
code:

| Broken | Result |
|---|---|
| provenance label only (`resolveCodexCatalog` always claims live) | 1 fail — the cache's seed-identity guard still holds |
| cache guards only (`isCodexSeedList` call sites removed) | 0 fail — honest provenance still holds |
| both, i.e. the true pre-fix state | 2 fail, including the full-chain test |

So a future refactor that breaks either one alone will not reopen the poisoning
hole, and the single-layer break results are *expected*, not a sign the tests
are toothless. Only the both-layers break exercises the original defect.

Commit `7b1a522c67` additionally funnelled the substitution through one
`resolveCodexCatalog()` / `applyCatalog()` path, because it had been written out
three times with the provenance label repeated by hand — which is how a label
and the thing it describes drift apart in the first place.

**Method note:** two of this task's own break-verifications were initially
vacuous — a `perl -0pi` substitution silently failed to match, and a `grep -c`
counted a function *definition* as a call site, so a "0 failures" result looked
meaningful when the edit had not applied. Always confirm a break actually landed
before believing what its test run tells you. Relatedly, `git stash -u` stashes
an untracked `node_modules` symlink and will manufacture a fake regression; use
a tracked-only `git stash` when comparing against a baseline.
