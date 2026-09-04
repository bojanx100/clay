# Coop UX final review scope — SATISFIED, gate CLOSED

Status: **READY.** Independent Codex review revision 3 completed with verdict
**READY and no P1/P2 findings** against the exact pinned target `0b59c7934d`
plus the doc correction `b4942fe677`. The reviewer traced canonical TopicRef
navigation and the shared phone/desktop renderer, found no unsafe session
fallback and no in-scope drift at `origin/bojan`, and reran the Now/topic
suites (110/110) and mobile suites (27/27). The review was strictly read-only:
no code, runtime, or topic state was changed by it, and it produced no child
records. The mandatory independent review gate is therefore satisfied and this
scope is closed; nothing below requires re-delegation.

History of the two earlier attempts is kept for the record. Both were dismissed
for worker-spawn failure, not for any review outcome:

| Task | What happened |
|---|---|
| `task-583a3704-9c2d-4591-bbd4-ad6b2a7351c5` | Produced only a preamble, then looped on connection-drop resume messages. Two `retry_task` calls with `freshSession=true` were accepted ("Retry scheduled … with stable task identity") but never spawned a worker; five `send_task_message` attempts over ~10 minutes all failed with `worker session not found`. |
| `task-56e74209-4267-4172-9029-aeb40962b166` | `delegate_task` returned `in session undefined`; a single liveness probe failed with `worker session not found`. |

**Neither produced any review content, findings, or verdict.** Nothing was lost,
and no reviewer opinion was discarded. The strong Codex route was
unavailable/at capacity at the time. Revision 3 later ran on a healthy route
and returned the READY verdict recorded above, so no further review task is to
be created from this file.

## Why this file exists

So the exact scope survived the dead task identities and could be re-delegated
verbatim, rather than being reconstructed from memory and quietly drifting.
That is what happened: revision 3 reviewed this scope unchanged.

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
  lib/coop-topic-disposition.js, lib/coop-topic-index.js,
  lib/coop-topic-index-migrations.js, lib/coop-topic-management.js,
  lib/coop-topic-projection.js,
  lib/coop-topic-connection.js, lib/coop-topic-live-index.js,
  lib/coop-now-index.js,
  lib/global-coop-projection.js, lib/project-task-orchestrator.js,
  lib/project-task-orchestrator-completion.js, lib/orchestration-task-graph.js,
  lib/sdk-message-processor.js, lib/users-permissions.js, lib/server.js,
  lib/public/modules/coop-action-queue-ui.js, coop-action-decision-panel.js,
  coop-topic-decision-surface.js, coop-lens-relevance.js,
  coop-header.js, coop-identity.js, global-coop-projection.js,
  sidebar-coop-topics.js, sidebar-coop-topic-model.js,
  sidebar-coop-topic-review.js, sidebar-coop-topic-close.js,
  sidebar-coop-topic-links.js, sidebar-sessions.js, sidebar-sessions-model.js,
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

MIGRATION-TRIGGER SEGMENT (follows the ZERO-TOPICS REGRESSION SEGMENT above):
owner evidence at ~15:45 falsified the prior trigger assumption — a genuine
owner message in the canonical Coop session left `titleRetrofitAudit=0` and
`anchorAudit=0`, proving real owner Coop traffic bypasses the
`validateCoopTopicIngress` hook the previous segment relied on. Superseding
design, exactly as directed:

- **`ensureTitleRetrofit(session)`** (new in `coop-topic-index.js`): an
  exactly-once, index-stamped migration (`state.titleRetrofit
  {schemaVersion, completedAt, retitled, mergedToUncategorised}`). Runs
  reconcile-then-retrofit against the daemon's authoritative cached index and
  cached canonical session, saves once, and thereafter is a single property
  check. Fails closed without burning the stamp when the canonical history is
  unavailable (`canonical_history_unavailable`), so an early empty-history
  call can never suppress every topic and mark the migration done.
- **Invoked from `advanceCanonicalCoopTopics`** in
  `global-coop-projection.js` — the one daemon path proven to execute with
  the real cached canonical session (topics demonstrably render through it),
  running on every projection build with no owner test message required. The
  projection built immediately after the migration already carries the new
  titles, so the normal broadcast path distributes them.
- **Anchor-audit staleness bug found and fixed while proving this**
  (`coop-topic-anchors.js` `isProjectable`): the projection trusted a
  current-schema `anchorAudit` verdict unconditionally, so a topic audited at
  zero anchors (e.g. reconciled before its first turn — exactly what the new
  always-on migration makes routine) stayed suppressed forever even after
  genuinely earning a proven turn. `isProjectable` now trusts the audit only
  while `anchorCount` still matches the topic's current `turnRefs` length and
  live-proves otherwise, mirroring `reconcileAnchors`'s own re-evaluation
  rule. Caught by the existing live-index test the moment the migration ran
  on its fixture — the test suite did its job.
- **Regression test using the exact failed ingress shape**
  (`test/global-coop-projection.test.js`): a fingerprint-intact garbled
  automatic topic anchored to a real owner turn, then nothing but
  `buildGlobalCoopProjection` — no message ingress at all. Asserts the
  persisted title is fixed and coherent, topicId preserved, seed title
  untouched, the stamp persisted, the returned projection carries the new
  title, a fresh index instance over the same file reports
  `alreadyComplete` without re-running, and an empty-history call refuses
  without stamping.

Verified on the owner's real transcripts: internal control records in Main went
to zero across all three (51945 / 30209 / 5722 records) while All is unchanged
and every owner message is preserved (102 / 41 / 8). Browser QA at 1440x900 and
390x844: Main showed zero tick markers and zero control envelopes; switching to
All revealed them again (20/20 blocks visible).

Live topic browser QA at `ace812cdb9` passed on a selected topic
(`?coopTopic=codex-authentication`): zero tool blocks, zero control envelopes,
zero Lead-tick markers, zero internal-marked DOM records, with the canonical
topic title in the header.

READABLE-TITLE SEGMENT (`85c576a63a`, retrofit schema v2): the owner rejected
the v1 retrofit output — titles like 'Taken Idle Didnt Take Messages' were
bag-of-words keyword joins that reordered and dropped the owner's words.
`derivedMetadata` now derives titles via `readableTitle()`: the first clause of
the proven owner turn verbatim, order and contractions preserved, front
boilerplate stripped, bounded to 8 words / 60 chars with an ellipsis. Schema v2
re-runs the projection-path migration exactly once; v1 machine-retitled topics
(audit action "retitled") are revisited despite the broken creation
fingerprint, while owner-renamed titles (no such audit), seeds, and topic IDs
stay protected. New titles are collision-checked. Live result: all 20 v1
word-salad titles replaced with readable owner phrases (26 retitled total),
stamp `{schemaVersion:2}` stable across reloads, 34 rows on desktop 1440x900
and phone 390x844, zero console errors.

DIAGNOSTIC-SUBJECT SEGMENT (`581b3da81a`, retrofit schema v3): the owner
corrected the v2 output — readable but non-diagnostic fragments remained as
topic names ('Yea, so', 'Can you implement that', 'Does this look like it',
'You know what, scratch 1', "It's all working"). `diagnosticTitle()` returns
the first clause of a turn carrying at least two concrete content words
(stopwords, front boilerplate, and vague verbs set aside); new admissions
prefer it. Schema v3 scans every proven turn of a machine-titled topic for a
diagnostic clause — 'You know what, scratch 1' → 'The project button is ok',
'Can you implement that' → 'One note opus 5 is still not a…' — and merges
fragments with no defensible subject anywhere into Uncategorised conversations
with membership preserved ('Yea, so', "It's all working", "Let me know when
it's finished is the…"). Live result: 8 retitled, 3 merged, stamp
`{schemaVersion:3}` stable across reloads and a daemon restart, 31 rows on
desktop 1440x900 and phone 390x844 (34 − 3 merges), all eight seed/owner
titles untouched, zero duplicate titles, zero blank labels, zero console
errors. Full suite 1753/1759 with only the six pre-existing baselines.

EVIDENCE-BASED STATE SEGMENT (`9592e5a9c9`, revision 26, disposition schema
v1): the owner reopened the implementation because most historical topics had
no durable topic→task evidence and blank rows told them nothing. Every
projected topic now carries exactly one truthful state — Working, Needs input,
or Done — never blank and never inferred from openness, with inspectable
provenance (`stateSource`). A versioned, exactly-once, fail-closed backfill
(`ensureDispositionBackfill`, same exactly-once contract as the title
retrofits) wrote durable `needs_input`/`unlinked_historical` owner-disposition
records for unprovable historical topics: live stamp
`{schemaVersion:1, linked:0, defaulted:33, kept:0}`, stable across reload and
a daemon restart. Done requires owner acceptance, an explicit close, or an
owner accept_done decision; completed worker output alone never reads Done.
Closed topics stay projectable into a compact collapsed Done section (merged
husks still never project). Per-topic owner decisions (accept_done /
request_changes with a required note / keep_waiting / reopen) flow through the
new owner-only `coop_topic_disposition` WS handler with a stale-state echo
check; the affordance renders only for disposition-backed topics, so
task-linked topics keep deciding through the existing Action required queue.
Review especially: `b912bd3bc8` (the feature), `4e1345aecf` — live QA caught
`canonicalCoopSessionForState` probing a nonexistent `lead.getSessions()`
accessor, so every computed state reached the client blank while direct
index.project tests stayed green; the accessor now reads
`getSessionManager().sessions` and the seam regression pins that shape — and
`9592e5a9c9` (the state pill no longer truncates to "NEEDS IN…"). Live
result: 31 rows on desktop 1440x900 and phone 390x844, 1 Working (live
foreground) + 30 Needs input, zero blanks, zero duplicate titles, zero
truncated pills, review panel opens with provenance text and the three verbs
on both surfaces, zero console errors. The isolated end-to-end owner decision
(accept → done, stale rejected, non-owner denied, note required) is proven in
`test/coop-topic-disposition.test.js` against fixtures, never against real
owner work. Full suite 1768/1774 with only the six pre-existing baselines.

REVIEW-FINDINGS SEGMENT (`db5fc84d24`, revision 29): the independent Codex
review of `9592e5a9c9` returned NOT READY with eight findings; all are fixed
and regression-covered in this single commit. P1-1: every mutating topic
operation (close/reopen/disposition/action decision) now requires canonical
owner identity via `isOwnerSocket` in the new `lib/coop-topic-management.js`
— slug AND injected `isCoopTopicOwner`, failing closed when the check is
missing; `projection_request` stays read-only. P1-2: both replay resolve
sites in `coop-topic-connection.js` pass `includeClosed=true`, so closed Done
topics replay their own indexed history on initial selection and reconnect
instead of falling to full canonical replay. P1-3: dispositions carry a
monotonic `revision` with an `expectedRevision` precondition
(`stale_disposition` on mismatch) plus bounded durable request dedup
persisted in the index (`dispositionRequests`, cap 32) that replays duplicate
requestIds without a second write and rejects requestId reuse across topics
(`request_conflict`); both survive restart because they live in the index
file. P2-4: dismissed/cancelled tasks (`ABANDONED_STATUSES`) no longer strand
topics in undecidable Needs input — all-abandoned topics fall back through
foreground/closed/disposition with stateSource `task_abandoned`, and the
review panel admits topic-scoped verbs for them. P2-5: successful decisions
fan out the authoritative projection to all connected owner viewers via
injected `refreshCoopTopicViewers` (ACL-filtered); dedup replays do not fan
out. P2-6: closed topics render Reopen instead of Close and the close copy
says the topic moves to the collapsed Done section; Close→Done→Reopen
round-trip is tested. P3-7: Review and Done disclosures carry stable
`aria-controls` panel ids with panels kept in the DOM when collapsed. P3-8:
`coop-topic-index.js` (487) and `coop-topic-connection.js` (457) are back
under the 500-line limit via two new focused modules,
`lib/coop-topic-index-migrations.js` (migrations + disposition writer +
request dedup) and `lib/coop-topic-management.js` (owner-gated mutations +
fan-out). Verification: isolated CLAY_HOME full suite 1781/1781 (zero
failures), live-config full suite 1775/1781 with only the six pre-existing
routing/catalog baselines, focused topic suites 109/109. Real index survived
a daemon restart with stamps and all 33 `unlinked_historical` dispositions
byte-identical; raw WS projection shows 31 rows, 0 blanks, every disposition
projecting `revision`; desktop 1440x900 and phone 390x844 QA green (0
blanks/dups/truncations/overflow, 31/31 review toggles with resolving
aria-controls, review panel opens with provenance and the three verbs, zero
console errors). No real owner dispositions were mutated.

TOPIC-ROW LAYOUT SEGMENT (`3f3315bdb8`, owner-approved redesign): the owner
rejected the previous list rendering as cramped and visually noisy — 31
identical uppercase "NEEDS INPUT" pills plus Review and Close controls
repeated on every row overwhelmed the titles. The row now leads with the
title as its only primary content; the state renders on a quiet secondary
meta line as plain words with the reinforcing dot (no borders, no uppercase,
never truncating), while the row's accessible name still announces
"title, state". Review stays the single visible action, inline on the meta
line, only when a topic-scoped decision is actionable; stateless
non-reviewable rows render no meta line at all. Close/Reopen moved behind a
compact overflow menu per row (`createTopicMenu` in
sidebar-coop-topic-close.js): aria-haspopup="menu"/aria-controls on the
toggle, role=menu/menuitem, Escape closes and returns focus to the toggle,
focusout dismisses, Close keeps the explicit confirmation modal, Reopen stays
one activation. Vertical rhythm and group spacing increased on both surfaces;
mobile keeps 42px touch targets with an always-visible toggle. Strictly a
client rendering change: topic state semantics, owner ACLs, dispositions,
request dedup, closed-topic discoverability/replay, canonical TopicRefs, and
all migrations are untouched. Layout-contract, menu-behaviour ARIA/keyboard,
and cross-surface CSS regression tests added; isolated CLAY_HOME full suite
1784/1784; live QA at 1440x900 and 390x844 showed 31 rows, 0 blank states,
0 overflow, 31/31 resolving aria-controls, zero console errors, no owner
data mutated.

LINK-ONLY INDEX + CONTEXTUAL DECISION SEGMENT (`0b2ce60bf3`, owner revision
32): the owner rejected the sidebar "Action required" cards as noisy — they
duplicated topic rows and asked Accept/Request changes from titles alone,
without evidence. The sidebar queue is now a compact link-only "Immediate
action" index: each row is a button with the topic/work title plus a concise
truthful reason ("Worker finished — review the result", "Needs your answer",
"Waiting for your answer", "Blocked — needs you", "Failed — decide what
happens next"), deduplicated by canonical TopicRef (one row per topic, "+N
more" suffix), navigating to the canonical topic first (server-stamped
`topicRef` from the task's durable `coopTopicRef`; `openTopic` falling
through to the session destination when the topic cannot be resolved), and
rendering NO decision verbs anywhere in the sidebar. All consequential
decisions moved to a contextual decision surface
(`coop-topic-decision-surface.js`) rendered above the selected topic's
conversation (#coop-topic-decision before #messages): task-scoped panels
(`coop-action-decision-panel.js`, split from queue-ui) show provenance meta,
evidence, the exact question, links, a note field and consequence copy
before the verbs; acceptance items WITHOUT canonical evidence fail closed
with a withheld message and no verbs; topic-scoped disposition panels
(always-open `createTopicDecisionPanel`, replacing the sidebar Review
toggle) carry provenance and consequence copy. Deduplication is inherent:
`topicReviewVerbs` still refuses task-derived states, so one decision has
exactly one surface. Transport, ack/requestId correlation, reconnect
interruption semantics, ACLs, stale-revision protections, closed replay and
TopicRefs are unchanged; server dedup now prefers the topic-linked copy over
recency. Sidebar/mobile CSS lost all decision-panel styles; the surface
styles live in messages.css. Dead `openCoopActionItemId` /
`openCoopTopicReviewId` repaint guards removed. Tests: queue-ui suite
rewritten for the link-only contract (49), new
coop-topic-decision-surface contract suite (13), server topicRef
stamping/dedup tests, controls/work-link regexes updated; isolated
CLAY_HOME full suite 1805/1805. Live QA at 1440x900 and 390x844 against the
real daemon: raw WS projection 50 action items / 31 topics all Needs input /
0 blanks, 50 link-only rows with truthful reasons and 0 verbs on both
surfaces, 8 rows correctly disabled (no destination), 31/31 lifecycle
overflow menus intact, selecting a topic set `?coopTopic=<canonical-id>` and
rendered the decision card with provenance, note, consequence copy and three
verbs (role=group/heading ARIA resolving, verbs and rows keyboard
focusable), 0 overflow, zero console errors, and no real owner decision was
fired.

TOPIC-ONLY "NOW" INDEX SEGMENT (`0b59c7934d`, owner revision 37 post-gate
correction): live evidence proved the revision-32 "Immediate action" list
failed the owner's current-work requirement — it rendered 50
acceptance/decision-only rows and no working-now items. The sidebar index is
now a bounded, deterministic, topic-only "Now" projection built server-side
in `lib/coop-now-index.js` (`buildNowIndex(topics, actionItems)`, emitted as
`nowIndex` on the global projection): attention topics first (topic-linked
queue items or `needs_input` with task-attention/awaiting-acceptance
sources), then genuinely working topics with the exact reason "Working now";
strict canonical TopicRef dedup with attention precedence; done topics,
quiet unlinked-historical dispositions, coordinator/task noise, and anything
without a resolvable canonical topic destination are excluded; oldest-first
deterministic ordering with TopicRef tiebreak, bounded to 20 rows. The
client (`coop-action-queue-ui.js`) renders heading "Now" with link-only
button rows (aria-labels, fail-closed disabled rows without a destination);
an empty index renders nothing. Old sidebar queue rendering
(`renderCoopActionQueue`/`dedupeItemsByTopic`/`actionItemReason`) removed;
the decision transport and the contextual decision surface are unchanged.
Tests: new `test/coop-now-index.test.js` (16), rewritten queue-ui sidebar
suite (49), decision-surface 13/13; isolated CLAY_HOME full suite 1821/1821.
Live QA at 1440x900 and 390x844 against the real daemon: raw WS projection
carried `nowIndex: []` alongside 50 legacy action items / 32 topics — an
empty index is the truthful current-work answer because no real task has a
durable topic link and every open topic is quiet-historical needs_input, so
the 50-row noise dropped to zero; no stale "Immediate action" section, no
sidebar decision verbs, 32 quiet topic rows with lifecycle overflow menus
(aria-haspopup/label) and Done (4) disclosure (aria-controls resolving)
intact; selecting a topic navigated canonically and rendered the contextual
decision surface with evidence/consequence copy; isolated fixture through
the real builder proved attention precedence for a
simultaneously-working+actionable topic, "Working now" inclusion, and
historical/done exclusion; zero console errors, no overflow, no owner
decision or topic lifecycle mutated (6 audit-closed topics and both
Webapp-inventory topics unchanged).

PIN INSPECTION HERE — the current review target, not the older commits listed
below (`0b59c7934d` is the topic-only Now index segment on top of
`0b2ce60bf3`, the link-only index + decision surface segment on top
of `3f3315bdb8`, the layout segment on top of `db5fc84d24`, the
review-findings segment on top of `9592e5a9c9`; the earlier note about
`f4688c9603`/`ace812cdb9` still holds for the Part 1 history).
`0b2ce60bf3`, `3f3315bdb8`, `db5fc84d24`, `9592e5a9c9` and `cde8fb67dc` are
superseded as final gates:

    git clone --shared . /tmp/coop-review && git -C /tmp/coop-review checkout 0b59c7934d

BRANCH DRIFT SINCE THE PIN (recorded 2026-08-12, no repin). `bojan` has
advanced 36 commits past `0b59c7934d`, and some touch files inside the
`ownedPaths` list above — `lib/coop-topic-index.js`,
`coop-topic-management.js`, `coop-topic-projection.js`, `coop-topic-state.js`,
`coop-topic-connection.js`, `lib/server.js`, `lib/sdk-message-processor.js`,
`lib/orchestration-task-graph.js`, `lib/project-task-orchestrator*.js`,
`lib/public/modules/sidebar-coop-topics.js`, `sidebar.css`, `messages.css`,
`mobile-nav.css`, `test/`. Those commits belong to separate admitted
workstreams (topic sealing, TopicRef threading, provider routing, coordinator
bindings), NOT to this UX segment. The pin is deliberately NOT moved to HEAD:
repinning would silently expand this review from one UX segment to 36
unrelated commits. Review the pinned commit as the exact target; treat the
drift list as context only.

Re-verified at HEAD on 2026-08-12 (read-only, nothing mutated):

- In-scope suites still green at HEAD: `coop-now-index`,
  `coop-action-queue-ui`, `coop-topic-decision-surface`,
  `global-coop-projection`, `coop-topic-sidebar-controls` — 110/110.
- Isolated full suite at the pinned commit `0b59c7934d`: 1821/1821.
- Isolated full suite at HEAD `118d8df77c` (clean `--shared` clone, deps
  linked): 2075/2076. The single failure is
  `test/project-task-orchestrator.test.js:1895` "startup contains unavailable
  worker routing without crashing the daemon" (`2 !== 1`, "no unroutable
  worker session is created"). It passes 55/55 when that file runs alone, so
  it is order/concurrency dependent, and it is green at the pin. It is a
  regression in the orchestrator/binding workstream landed after this pin —
  outside this review scope, left unpatched here because that workstream is
  concurrently active. Worth knowing: it is the guard that makes an unhealthy
  provider route fail closed into `needs_input` instead of spawning an
  unroutable worker, i.e. the same machinery that is currently blocking this
  review gate.
- Owned task graph reconciled from the session ledger: 34 distinct tasks, 23
  `completed`, 11 `dismissed`, zero active or needing attention. No stranded
  `pending`/`unrouted` binding record remains.

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
