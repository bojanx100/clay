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

HEAD is now `c8d0b6e4b7` on `bojan` (was `af93548f6f` when this file was
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

KNOWN NOT DONE, admitted and still open: the topic list still contains
internal-derived and fragmentary topics ("Resuming After Restart", "Resuming
Interrupted Response", "None Been Taken Were Idle", "Don Create Project
Categorised Them" and ~30 similar single-turn fragments). The provenance fix
stops NEW internal-derived topics being admitted, but these were minted before
it and persist in the canonical index; no retro-cleanup or fragment
suppression/separation has been implemented. This is the owner's stated root
problem alongside the missing work links and must not be reported as resolved.

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
below (`f4688c9603` is `ace812cdb9` plus this scope document; no production code
differs between them):

    git clone --shared . /tmp/coop-review && git -C /tmp/coop-review checkout f4688c9603

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
