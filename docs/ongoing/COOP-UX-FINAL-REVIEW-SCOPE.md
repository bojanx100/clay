# Coop UX final review scope — PENDING, gate OPEN

Status: **NOT READY.** The implementation at `af93548f6f` is complete and
verified by the coordinator, but the mandatory independent review gate has
**never been satisfied**. Two review tasks were dismissed for worker-spawn
failure, not for any review outcome:

| Task | What happened |
|---|---|
| `task-583a3704-9c2d-4591-bbd4-ad6b2a7351c5` | Produced only a preamble, then looped on connection-drop resume messages. Two `retry_task` calls with `freshSession=true` were accepted ("Retry scheduled … with stable task identity") but never spawned a worker; five `send_task_message` attempts over ~10 minutes all failed with `worker session not found`. |
| `task-56e74209-4267-4172-9029-aeb40962b166` | `delegate_task` returned `in session undefined`; a single liveness probe failed with `worker session not found`. |

**Neither produced any review content, findings, or verdict.** Nothing was lost,
and no reviewer opinion has been discarded. The strong Codex route was
unavailable/at capacity. Do not retry the same route immediately and do not
create duplicate tasks; wait for a genuinely healthy strong Codex candidate,
then create **one** fresh visible read-only review task using the scope below,
unchanged. No provider CLI.

## Why this file exists

So the exact scope survives the dead task identities and can be re-delegated
verbatim, rather than being reconstructed from memory and quietly drifting.

---

## Delegation parameters

- `provider`: `codex`
- `mode`: `direct_leaf`
- No `targetProject` — this coordinator session is itself the active
  `project_coordinator` binding for this project, and
  `lib/project-task-orchestrator-external.js:436` rejects a cross-project source
  session that already carries execution metadata. Passing `targetProject` from
  here fails with "Source Coop session is unavailable". Delegate **locally**.
- `ownedPaths` must begin with `read-only:` and cover:
  `lib/coop-action-queue.js, lib/coop-action-decision.js,
  lib/coop-topic-relevance.js, lib/coop-topic-state.js,
  lib/coop-topic-connection.js, lib/coop-topic-live-index.js,
  lib/global-coop-projection.js, lib/project-task-orchestrator.js,
  lib/project-task-orchestrator-completion.js, lib/orchestration-task-graph.js,
  lib/sdk-message-processor.js, lib/users-permissions.js, lib/server.js,
  lib/public/modules/coop-action-queue-ui.js, coop-lens-relevance.js,
  coop-header.js, coop-identity.js, global-coop-projection.js,
  sidebar-coop-topics.js, sidebar-sessions.js, sidebar-sessions-model.js,
  sidebar-mobile.js, sidebar-mobile-coordinators.js, sidebar-lead.js,
  app-connection.js, app-messages-sessions.js, app-projects.js,
  lib/public/css/sidebar.css, mobile-nav.css, messages.css, test/,
  docs/ongoing/PROJECT-LIST-ACL-LEAKS.md`

Strictly read-only: no edits, staging, commits, pushes, reverts, PRs, or issue
comments. Proceed autonomously to a terminal report; there is no approval gate
and no owner question to ask.

## Review target

HEAD is now `3fc7f0a11a` on `bojan` (was `af93548f6f` when this file was
written). Two further admitted fixes landed since and are IN SCOPE:

- `4c526833e8` — portfolio bindings: a delegation that fails before the task
  exists no longer strands a `pending` reservation. Adds a non-blocking,
  ref-less, re-armable `unrouted` status, caller-scoped rollback, and bounded
  reconciliation on store load and on invocation. This is the infrastructure
  defect that blocked this very review gate; the five stranded records were
  reconciled through the supported API, not by hand-editing state.
  Review especially: that the age bound cannot cancel a binding that is
  legitimately mid-start, that only the reserving caller releases, that no
  duplicate worker is possible, and that exact-r1 retry and r2-after-failure are
  both safe.
- `8ac2d90aa8` — Main filtering: injected control prompts (the scheduled Lead
  tick, resume/continue markers, worker-update envelopes, compaction
  re-injections) reached Main as bare `user_message` records carrying no
  durable internal flag at all. Now classified by OWNER PROVENANCE
  (`from` / `fromName` / `clientMessageId` / `coopIngress*`), never by prose, on
  the replay path, the live client path, and at topic admission.
  Review especially: that no genuine owner message can be hidden — including an
  owner message whose text mentions the tick — that assistant output is never
  swept up, that `coopIngress*` presence with an empty value does not count as
  provenance, and that All remains full fidelity.

- `ace812cdb9` — topic lens replay: topic membership is stored as turn SPANS,
  and `boundedMembershipIndexes` expanded each range wholesale, so a topic chat
  replayed the tool traffic, thinking, rate-limit and status envelopes and
  injected prompts sitting between the owner's message and the answer. Main
  filtered; this path did not. Measured on one real session, raw span expansion
  admitted 809 internal records (670 tool, 77 rate_limit, 33 message_uuid, 11
  injected user_messages); after the fix, zero. The rule is now defined once as
  `isOwnerRelevantRecord` and shared by Main and the topic path via
  `ownerRelevantIndexes`, because having two definitions is what let them drift.
  Review especially: that narrowing can only REMOVE and can never introduce an
  index membership did not admit (so a topic cannot absorb unrelated owner
  conversation), that All is untouched by this path, and that topic membership
  correctness — which turns belong — is still a separate concern from relevance.

- `e3642d466a` then `c8d0b6e4b7` — topic state labels. e3642d466a made Working
  the default when a topic had no linked task, so every visible topic declared
  Working. The owner rejected it: the labels were useless and factually
  unsupported. c8d0b6e4b7 reverts that default. State is evidence-based again --
  Working only for linked active work or foreground on that exact lens, Needs
  input only for linked owner-attention or terminal-unaccepted work, Done only
  for linked completed work WITH durable owner acceptance; existence, recency
  and message content remain non-inputs. Explicit text labels are kept for
  topics that DO have a real state, stacked under the title so a real label
  never crushes it.
  MEASURED GROUND TRUTH, and the reason no label currently appears: there are
  ZERO canonical task records anywhere in ~/.clay -- not zero links, zero tasks.
  So no topic can carry a truthful state today and silence on all 42 rows is the
  correct output, not a rendering bug.
  Review especially: that no code path can produce a state without exact linked
  evidence, and that the differentiated-states test genuinely proves rows do not
  all read the same when evidence exists.

- `3fc7f0a11a` — no status affordance without a truthful state. Reverting the
  fabricated label left its LAYOUT behind: the row still wrapped and the dot was
  still rendered unconditionally, so every stateless topic drew a floating dot
  on a reserved blank status line above its title. The dot and the wrap are now
  conditional on a real label. Verified live after restart at 1440x900 and
  390x844: 43 rows, zero dots, zero labels, zero wrapped rows, uniform
  single-line height (29px desktop / 42px phone), zero dot-without-label.

NEW DIAGNOSIS of the fragment problem, replacing the earlier guess. The
admission filter (coop-topic-index.js:384, topicHasRelevantTurn) IS active and
history IS supplied, yet "Resuming After Restart", "None Been Taken Were Idle"
and "Where Arre Now" all pass it. Resolving their stored turnRefs against the
canonical history shows why: startEventIndex points at `scheduled_message_sent`,
`delta` and `done` records respectively -- not at owner turn-start records. The
persisted membership indices have drifted out of alignment with the history they
reference, so admission is evaluating the wrong records and topic titles are
derived from whatever record the index happens to land on. This is a membership
ANCHORING defect, not a relevance defect, and it is the real root of both the
fragment titles and the surviving internal-derived topics. Fixing it means
re-anchoring or re-deriving topic membership against canonical history; it was
NOT attempted here.

KNOWN NOT DONE, admitted and still open: the topic list still contains
internal-derived and fragmentary topics ("Resuming After Restart", "Resuming
Interrupted Response", "None Been Taken Were Idle", "Don Create Project
Categorised Them" and ~30 similar single-turn fragments). The provenance fix
stops NEW internal-derived topics being admitted, but these were minted before
it and persist in the canonical index; no retro-cleanup or fragment
suppression/separation has been implemented. This is the owner's stated root
problem alongside the missing work links and must not be reported as resolved.

FOLLOW-UP SEGMENT: three of the remaining gaps above are now addressed;
retro-cleanup of already-minted fragments is not.

- **Task-to-topic linking is now populated.** `orchestration-task-graph.js`
  `createTask` was setting `coopTopicRef` from the caller's explicit input only,
  and no caller ever passed one — confirmed against the live canonical session
  (`~/.clay`), which has 23 real persisted `orchestrationTasks`, all with
  `coopTopicRef: undefined`. It now falls back, when the caller passed nothing
  and the task is being created on the canonical Coop session itself
  (`session.coopHome`), to that session's own `coopWorkActivity.latestCoopRoute`
  — the durable "last routed owner turn" record already used elsewhere for the
  same purpose. This is real evidence (the owner's own last-addressed topic on
  the exact session about to own the task), captured once at creation and never
  recomputed, same as an explicit ref. A worker or project-coordinator session
  has no such route to read and stays unlinked. `coop-topic-state.js`'s
  evidence-based Working/Needs input/Done precedence was already correct and
  unchanged; it can now actually see linked work. Tests:
  `test/coop-topic-work-link.test.js`.
- **Garbled auto-titles were traced to two separate, fixable bugs in
  `coop-topic-classification.js`**, not to anchor drift (anchor drift was
  already fixed and is a different defect). First: `normalizeText` replaced
  apostrophes with whitespace, so a contraction like "don't" split into a real
  word ("don") plus an orphan fragment ("t", silently dropped for being too
  short) — "don" then survived stopword filtering and showed up as a stray word
  in the derived title (e.g. "Don Create Project Categorised Them"). Apostrophes
  are now dropped without inserting a space, so contractions collapse to one
  token ("dont"), and the collapsed forms are in the stopword list. Second: the
  stopword list only covered ~20 words, so ordinary function/modal/question
  words ("should", "would", "been", "none", "what", "were", ...) survived
  filtering and read as scrambled nonsense next to real content words even
  though the underlying word order was never altered. The list is now a
  fuller, still-deterministic set of common English function words. Verified:
  "What do you mean by checking whether it should be delegated" now titles as
  "Checking Whether Delegated" (was "What Mean Checking Should Delegated");
  "Don't create a project, just categorise them" now titles as "Create Project
  Categorise Them" (was "Don Create Project Categorised Them").
- **Single-turn fragment topics are no longer minted for low-information
  turns with nothing to attach to.** `classifyIngress` already had a
  `lowInformation(text)` check, but it only reused a *recent* topic when one
  existed — a low-information turn with no recent topic (e.g. early in a
  session, or after a topic gap) fell through to automatic-topic creation and
  minted its own permanent one-off topic from 1-2 words ("Where Arre Now",
  "Does Look Like", "How Going Show" — all confirmed still present in the live
  index with 1-2 turnRefs each, real owner turns, not anchor-drift artifacts).
  Such a turn now falls back to the `uncategorised-conversations` catch-all
  instead, so it is preserved (nothing is orphaned) but does not get its own
  sidebar row. Scoped to the uncategorised group only — a low-information turn
  inside a named project conversation still goes through the normal path.
  Tests: `test/coop-topic-index.test.js`.
- **Retro-cleanup of the ~30 already-minted fragment topics was deliberately
  NOT attempted.** Their `topicId` is a hash of their (bad) derived title, so
  the only way to retroactively fix them is a `RETRO_VERSION` bump, which
  clears `turnRefs`/`eventRefs` on every automatic topic and replays the
  canonical session's entire history through the classifier from event 0. That
  is a much larger blast radius than a title fix — it can reshuffle which
  existing topics turns land in project-wide, not just repair titles — and was
  judged too risky to do inside this segment without owner sign-off on that
  specific trade-off. They remain visible with their original (now
  demonstrably fixable) titles until a dedicated retro-cleanup pass is run.
- **Full live-daemon visual QA (desktop + phone) was not performed this
  segment.** Spinning up any daemon instance against a copy of the canonical
  session/task data — even for read-only visual verification — starts the
  same autonomous Lead-tick loop the production instance runs, spawning real
  worker sessions against live model providers on copied data. That is not a
  safe way to visually verify a sidebar rendering change, so it was not done.
  Verification for this segment is: full test suite (1730 tests, 1724 pass,
  the same 6 pre-existing unrelated provider/model-routing failures as
  before, 0 new failures), plus direct inspection of the live canonical
  topic index and session file to confirm the diagnoses above against real
  data. The sidebar's rendering code itself (dot/label/wrap suppression,
  Main/All lens behavior) was not touched this segment and remains covered by
  the existing passing tests from the prior segment.

RETROFIT SEGMENT (follows the FOLLOW-UP SEGMENT above): implements the
retro-cleanup deliberately not attempted above, without the `RETRO_VERSION`
full-reclassification blast radius.

- **`lib/coop-topic-retrofit.js` (new)** performs a bounded, versioned,
  idempotent title retrofit over existing automatic+open topics only, using
  the already-proven anchors from `coop-topic-anchors.js` and the corrected
  classifier from the prior segment. Never touches `topicRef.topicId` (every
  existing link — a task's `coopTopicRef`, a deep link — keeps resolving), and
  is fail-closed at every step: a topic with zero proven anchors is left alone
  (already unprojectable); a title whose creation fingerprint no longer
  matches (`isUnmodifiedAutomaticTitle`, new export in
  `coop-topic-classification.js` — recomputes
  `sha256(groupKey + "\n" + normalizeText(title))` and compares to the
  topicId's hash suffix, which is fixed at creation and never recomputed by
  the running system) is left alone, meaning an owner rename — or any other
  process that already touched the title — can never be silently overwritten;
  proven text that is still low-information after the classifier fix is
  merged into `uncategorised-conversations` (membership moved, `status:
  "merged"`, `mergedInto` set, mirroring the existing manual `merge()`
  convention) rather than retitled into another fragment; everything else is
  retitled from the combined text of its own proven turns only. A per-topic
  `titleRetrofitAudit` (`schemaVersion`, `checkedAt`, `provenCount`, `action`)
  makes `retitled`/`merged_uncategorised` **sticky forever** — once fixed, a
  topic is never re-touched even if it later gains more proven anchors — while
  an unresolved topic (no proven anchor yet, or an owner-modified title) is
  re-checked only if its proven-anchor count changes. Canonical session
  history is read-only throughout (only `history[eventIndex].text` is read, at
  the anchor-proven index — including the legacy `+1`-offset case, resolved via
  `topicAnchors.proveAnchor`'s reported offset rather than trusting the raw
  stored `startEventIndex`, so title text is never sourced from a "done"
  boundary record instead of the real owner message); nothing is ever written
  back to the `.jsonl` transcript. Wired into `coop-topic-index.js` as
  `retrofitTopicTitles(session)`, mirroring `reconcileTopicAnchors`'s existing
  pattern (resolve the canonical session, load the index, run the retrofit,
  save only if something changed). Tests:
  `test/coop-topic-retrofit.test.js` (17 tests: retitling, contraction/fringe
  fixes, multi-turn combination, legacy-offset text sourcing, topicId
  preservation, owner-modified-title protection, manual/seed/closed/merged
  topics never touched, no-proven-anchor topics left alone and recorded,
  low-information merge without absorbing unrelated conversation, two-run and
  JSON-round-trip idempotency, history-is-read-only, and a full before/after
  inventory shape) plus one wiring test added to
  `test/coop-topic-index.test.js` (fixes an injected pre-fix garbled topic
  end-to-end through `retrofitTopicTitles`, confirms it survives an index
  reload from a fresh `createTopicIndex()`, and that a second call — on the
  live in-memory index or after a fresh load — is a no-op).
- **Real before/after inventory, produced against live production data,
  read-only.** A standalone in-process script loaded the real
  `~/.clay/lead/coop-topic-index.json` and the real canonical session's
  `.jsonl` transcript (871a194b…, 55,592 records) directly via `fs.readFileSync`
  — bypassing `createTopicIndex()`'s file-writing API entirely — ran
  `retrofitTitles` once against an in-memory clone, and never called any
  save/write path. The production file on disk was confirmed byte-for-byte
  unchanged (still exactly 44 topics) after the run. Result across the 44
  live `automatic && open` topics: **20 retitled** (contraction-mangled and
  stopword-cluttered titles replaced with coherent ones drawn from their own
  real proven turn text — e.g. `"Don Create Project Categorised Them"` →
  `"Create Project Categorised Them Keep"`, the `"Don"` fragment gone), **8
  merged into `uncategorised-conversations`** (genuinely low-information
  single-turn fragments — `"Where Arre Now"`, `"Does Look Like"`, and similar
  — membership preserved, no longer their own sidebar row), **8 skipped as
  owner-modified** (the seven named seed topics plus the catch-all itself,
  e.g. `"Codex authentication"`, `"Coop conversation architecture"` — their
  titles do not match their own creation fingerprint, which the retrofit
  correctly reads as "already deliberately titled," never touched, even
  though production's seed topics happen to carry `source: "automatic"` in
  the stored index rather than a distinct seed/manual marker — the
  fingerprint check protects them independent of that field), and **2
  skipped as having no proven anchor** (`"Resuming After Restart"`,
  `"Resuming Interrupted Response"` — the same two internal-control-derived
  topics the anchoring fix already correctly withholds from the owner;
  nothing new suppressed them, the retrofit just correctly declines to guess
  a title for what is already invisible). `20 + 8 + 8 + 2 = 44`, the full
  set. Re-running the same script against the now-retrofitted in-memory
  index, and again after a `JSON.parse(JSON.stringify(...))` round-trip
  (simulating a restart), both reported `retitled: 0, mergedToUncategorised:
  0` — every one of the 36 still-open automatic topics reported `unchanged`,
  proving the fix is idempotent and restart-stable against the real data, not
  just the synthetic test fixtures. **This inventory has not been applied to
  the live file** — production `~/.clay/lead/coop-topic-index.json` still has
  its original 44 titles as of this writing; applying it is a deliberate,
  separate step (calling `retrofitTopicTitles(canonicalSession)` from within
  the running daemon process, which has the real `session` object with
  `coopHome`/`storageId` already resolved) that was intentionally not taken
  in this dry-run-only segment, since doing so from a standalone script
  would require re-deriving daemon-internal session state outside the
  daemon's own code path — the same class of risk (acting on a guessed
  session shape rather than the real one) this whole retrofit is designed to
  avoid.
- **Live-daemon visual QA remains not performed, same reason as the prior
  segment** (spinning up any daemon against copied data triggers the real
  autonomous Lead-tick loop against live model providers). This segment's
  verification is the read-only production dry-run above (real index, real
  history, in-memory only, disk untouched, proven idempotent/restart-stable)
  plus the full test suite: 1748 tests, 1742 pass, the same 6 pre-existing
  unrelated provider/model-routing failures as every prior segment, 0 new
  failures.

ZERO-TOPICS REGRESSION SEGMENT (follows the RETROFIT SEGMENT above): at ~14:34
the owner's phone showed the Coop Projects sheet with only Main and All — the
entire Topics section absent. Root cause was **not** a code defect in any
committed fix: the production daemon (a long-lived process with in-memory code
and a `getDefaultTopicIndex()` singleton) had last been started at 13:03,
mid-way through the anchoring work, running an intermediate tree in which
`isProjectable` accepted only canonical offset-0 anchors — and every real
persisted turnRef is legacy-shaped (offset +1), so the stale process suppressed
all 44 topics at once, exactly the fail-closed behavior that code was designed
to have before the legacy fallback landed at 13:19. The committed code was
verified correct against production data: an in-process simulation of the exact
server path (`project({history})` over the real index + real 55,592-record
canonical transcript) projects **42 topics across 4 groups** (4 cross_project,
2 project clay, 1 other project, 35 uncategorised) with the two
internal-control fragments correctly withheld. Fix: daemon restart onto current
HEAD (owner-visible before: 0 topics; after: 42). Hardening in this segment:

- **`retrofitTopicTitles` is now wired into the daemon's own ingress path**
  (`lib/project-user-message.js`, immediately after `reconcileTopicAnchors`,
  same genuine-owner-traffic-only trigger), so the retrofit dry-run inventory
  above is applied by the running daemon through its own real session object —
  the deliberate deferred step from the prior segment, closed the intended way.
- **Regression test** in `test/coop-topic-index.test.js` ("a real legacy-shaped
  canonical index still projects valid topics after migration and restart"):
  rewrites every turnRef of a real retro-extracted index into the legacy
  boundary-record shape production actually has, runs
  reconcile + retrofit + save, reloads through a fresh `createTopicIndex()`
  (simulating the daemon restart), and asserts the projection still renders
  the valid topics while an injected genuinely-drifted fragment stays
  suppressed and the migration is a reload-stable no-op on the second run. A
  valid-data/zero-projected-topics outcome now fails the suite.

Verified on the owner's real transcripts: internal control records in Main went
to zero across all three (51945 / 30209 / 5722 records) while All is unchanged
and every owner message is preserved (102 / 41 / 8). Browser QA at 1440x900 and
390x844: Main showed zero tick markers and zero control envelopes; switching to
All revealed them again (20/20 blocks visible).

Live topic browser QA at `ace812cdb9` passed on a selected topic
(`?coopTopic=codex-authentication`): zero tool blocks, zero control envelopes,
zero Lead-tick markers, zero internal-marked DOM records, with the canonical
topic title in the header.

PIN INSPECTION HERE — the current review target, not the older commits listed
below (`090961890c` is the zero-topics regression fix segment on top of
`62c7d848c9`; the earlier note about `f4688c9603`/`ace812cdb9` still holds for
the Part 1 history):

    git clone --shared . /tmp/coop-review && git -C /tmp/coop-review checkout 090961890c

The seven-fix audit in Part 1 concerns the earlier commits in this history:

**Never use `git stash` in this repo** — it has eaten work here before.

Commits under review (oldest first): `4b7acd9899` topic admission on relevance ·
`892ecaac3b` real Working/Needs input/Done · `550323e466` Main default, All full
fidelity · `803bc49d80` continuous Main relevance · `2dd47a7350` Main selectable ·
`d467ad24a2` Bash/tool classified out of Main by real event types · `ec5b78b2b8`
Action required queue · `41109692bd` owner decision panels · `5aa5f17c06` fixes
for seven prior findings · `af93548f6f` test-only follow-up.

## Part 1 — verify the seven prior fixes

A prior review at `41109692bd` returned NOT READY with 1 P1 and 6 P2.
`5aa5f17c06` claims to close all seven. State each as **CLOSED / NOT CLOSED /
PARTIALLY CLOSED** with evidence, actively trying to *refute* the fix.

1. **P1 owner authority.** `connectedUserIsCoopOwner(ws)` in `lib/server.js` now
   gates the decision route (`isOwner` into `applyDecision`, checked before any
   project/task resolution) and the projection (`includeActionQueue`). Verify a
   non-owner admin can neither mutate nor see the queue; that ACLs still apply
   on top; whether `if (!users.isMultiUser()) return true;` re-opens a hole; and
   — since `isCoopClient` is **still slug-only** — whether any other route
   reachable through `handleCoopMessage` now needs the same gate.
2. **Coop identity.** No owner-facing "Lead" should remain. Scheduled-task
   *names*, transcript prose, and the "Lead mode" setting legitimately keep the
   word — do not report those.
3. **Unicode note escape.** Try to defeat `cleanText`/`noteText`: other
   line-break or direction characters, homoglyph envelope markers, `MAX_NOTE`
   truncation landing mid-escape, surrogate pairs, repeated `>>>`.
4. **Dropped ACK.** Any path still leaving an item pending forever; and whether
   reconcile can wrongly clear a decision genuinely in flight on a healthy socket.
5. **`thinking_delta`.** Verify against really emitted types
   (`lib/sdk-message-processor.js`) that nothing conversational is swallowed and
   nothing operational still leaks; judge whether the >300 replay-window
   regression is meaningful.
6. **Done reachable.** `accept` / `revoke_acceptance` write a durable revocable
   `ownerAcceptance`; Done must be reachable **and** revocable end to end through
   the real `coop-topic-state` predicate; dismissed/cancelled work not asked about.
7. **Dedupe identity.** Issue number preferred over `clientRef`; same issue with
   different refs collapses; distinct work never merges.

## Part 2 — regressions across the wider outcome

Switcher exactly once at 390x844 and mates hidden when disabled · Main default
and selectable, All full fidelity, render-signature/subscription guards cannot
suppress a lens change (both lenses are ref-less, which previously made Main
unselectable) · continuous legacy **and** live tool/Bash filtering that preserves
owner content and keeps the flat ordered `#messages` child invariants · topic
admission and Working/Needs input/Done with terminal work awaiting preview
staying Needs input and Closed separate · queue top-level with internal
coordinators hidden and `#2503` = "Mail attachment (parent/child) icons"/PR #2504
vs `#2517` = "Excel Viewer - view only"/PR #2526 never cross-wired · decision
panels clickable **and** keyboard-operable, visible focus,
`aria-expanded`/`aria-controls`, opening in Coop without entering the project ·
Advance scoped to one task and never an implicit merge/close/project-complete ·
isolation, stale/TOCTOU, double submit, ACK/pending/error, reconnect/restart ·
ACL and reference-only discipline (the three leaks in
`docs/ongoing/PROJECT-LIST-ACL-LEAKS.md` are **pre-existing and out of scope**).

## Part 3 — test honesty (first-class deliverable)

Flag any test that would still pass if the behaviour it names were broken. This
work has already had three such failures:

- a guessed event-type denylist whose tests used the same invented vocabulary,
  so they agreed with the code and proved nothing;
- a destination shape its own tests accepted but the real consumer
  (`openResolvedGlobalSession`) silently rejected, so clicking did nothing;
- a reconnect test that emptied the queue first and therefore never modelled the
  reconnect it was named for.

Judge specifically the two tests added in `af93548f6f` — they exist because the
live queue is empty, so acceptance items could not be exercised live. Decide
whether they genuinely close that gap or are more self-referential fixtures.

## Tests

    node --test test/coop-action-queue.test.js test/coop-action-queue-ui.test.js \
      test/coop-action-decision.test.js test/coop-topic-relevance.test.js \
      test/coop-topic-state.test.js test/coop-main-lens.test.js \
      test/coop-main-lens-interaction.test.js test/coop-live-lens-filtering.test.js \
      test/mobile-project-switcher.test.js test/mobile-switcher-lifecycle.test.js \
      test/mobile-mates-disabled.test.js test/mobile-lead-navigation.test.js \
      test/coop-topic-admission.test.js
    node --test "test/*.test.js"

Live repo: **1663 tests / 1657 pass / 6 fail**. Those 6 are pre-existing
model-catalog and worker-routing failures, unrelated to this work:
"adaptively routes unpinned coordinator work and records the rationale";
"architecture and security tasks require a strict frontier route";
"frontier fallback prefers a verified compatible Copilot route before Sol";
"frontier fallback reaches OpenAI Sol when the compatible Copilot route is
unavailable"; "native Claude does not advertise or select Opus 5 without exact
catalog evidence"; "native Claude never selects Opus 5 when its verified catalog
omits it".

A previous reviewer reported 163/1556 and could not reproduce those six, because
a bare clone lacks the local `~/.clay` configuration and the ignored
`node_modules`. **If reviewing in a clone, also run the suite in the LIVE repo**
before attributing any difference to this work. Report any failure beyond those
six, and report the working-tree state exactly.

## Coordinator claims to refute (do not merely repeat)

- Full suite 1663/1657 with the six pre-existing failures; focused suites green;
  tree clean.
- The Unicode fix was verified by building a hostile note from U+2028, U+2029,
  U+0085, U+202E and U+200B and asserting the directive has exactly one `Task:`
  line (the real one), one envelope header, zero standalone ADVANCE lines,
  intact quoting, and no surviving separator or bidi characters.
- Live browser QA at 1440x900 and 390x844: cards focusable and openable in place
  with `location.pathname` still `/p/lead/`, `aria-expanded`/`aria-controls`
  matching, an acceptance item offering "Accept as done" rather than "Advance",
  a blocked item offering Advance with the note box and the correct Issue #2503 /
  PR #2504 pairing, 44px touch targets, zero desktop controls visible at phone
  width, one panel open at a time, no overflow.

## Known gaps — attack these hardest

- The **live action queue is empty** (zero attention-state, zero
  completed-but-unaccepted, verified by scanning `~/.clay`), so browser QA
  injected a server-shaped queue into the **client store only** and mutated no
  server state. The live server→client path for acceptance items was **not**
  exercised end to end.
- **Advance, Request changes, Accept and Reopen were never fired against real
  owner work**, because that would mutate genuine decisions. Test-covered only.
- Example of the failure mode to hunt: the first owner gate resolved the
  canonical Coop session *before* checking multi-user mode, so on a single-user
  daemon whose Lead project was not warmed it failed closed and withheld the
  owner's own queue. Caught in live QA and fixed by short-circuiting single-user
  first.

## Required ending

    REVIEW_VERDICT: READY        (or NOT READY)
    WORKER_STATUS: completed     (or blocked)
    ESCALATION_REQUIRED: no      (or yes)

READY only if there are no unresolved P1/P2 findings. A clean review is an
acceptable and expected outcome — do not invent findings. State explicitly what
could not be verified and why.
