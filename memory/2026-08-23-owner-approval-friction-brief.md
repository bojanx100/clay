# Owner-approval friction: diagnosis, one landed fix, and the design for a looser model

Date: 2026-08-23. Owner ingress 680 ("Fix the owner approval friction in clay"), raised after
675/679 failed to bind. Task `clay-one-shot-loose-approval-design-2026-08-23`.

The complaint: the owner wants to say something once, in their own words, and have it bind to the
right task. Today they sometimes need two or three attempts with particular phrasing.

## Correction to the task premise: there was no 2026-08-16 hijack

The brief that commissioned this work refers to "the 2026-08-16 incident". That is a misdating and
should not be repeated. No `memory/2026-08-16-*.md` note mentions a hijack; the four notes from
that date are a different `thread_ref_required` symptom (scheduler-created candidates with no
owner ingress, `memory/2026-08-16-autonomous-board-thread-admission-debug.md`).

The hijack was **measured on 2026-08-19** and is recorded in
`memory/2026-08-19-thread-ref-required-dispatch-blocker-brief.md:24-39`. A dispatch of
`webapp-automation-policy-board-exclusions` rev2 into project `b0c9b7a0` adopted owner turn `:482`
— the text "FIX!" — which belonged to a different project. Mechanism, one guard clause at
`lib/project-task-orchestrator-external-delegation.js:466`: a dispatch naming no Thread makes
`requested` falsy, which switches the filter off entirely, so the history scan returned the latest
implementation ingress *anywhere*, and returning on match shadowed the only routes that could mint
a Thread. Cost: two portfolio items unstaffable, and per commit `cd1047a1b7`, "an operator spent
two days hunting a Thread-minting gap".

Also worth carrying forward from `memory/2026-08-19-coop-dispatch-outage-handoff.md:24-40`: three
blockers stacked and **blocker 3 dominated** (stale `requestRef.eventIndex`, 1/503 resolving).
The hijack was real but was not the dominant cause of that outage.

## What was actually fixed (2026-08-23)

Only one thing, in `test/`. It is not the friction the owner reported, but it is a real defect that
was actively punishing the owner for using the intended remedy.

**The suite was asserting the owner's autonomy switch value, not the admission rules.**
`coop-autonomy-grant.loadPolicy` falls back to `defaultFile()` — the *shipped* repo-root
`scoped-autonomy-policy.json` (`lib/coop-autonomy-grant.js:74-76, 152-154`) — whenever
`autonomyPolicyFile` is absent. Several tests passed `undefined` for that seam, so they silently
read the shipped switch:

- `test/coop-thread-execution-admission.test.js` — the shared `executionRouter` harness forwarded
  `options.autonomyPolicyFile` unchanged, so three expected refusals became admissions.
- `test/coop-widened-autonomy-grant.test.js` — a test named "the grant ships off" asserted
  `shipped.enabled === false` outright.

Consequence: with the switch flipped ON, 4 tests fail. `npm test` backstops every commit, so **the
owner could not durably enable their own autonomy grant without a red suite** — approval friction
in the most literal sense, created by the very feature meant to reduce it.

Fix: make both hermetic. The router harness now defaults the seam to a path inside its temp dir
(an absent file reads as no grant, which is what those tests mean). The grant test was split into
the real invariant — OFF is byte-identical to no grant, proven against a temporary OFF policy — and
a separate check that the shipped file stays well formed with its `permanentlyGated` set intact.
`enabled` is the owner's data and is no longer asserted.

Evidence, both switch states, run in a clean worktree at HEAD and in the working tree:

| | switch OFF | switch ON |
|---|---|---|
| `coop-thread-execution-admission` before fix | 38/38 | **35 pass / 3 fail** |
| `coop-thread-execution-admission` after fix | 38/38 | 38/38 |
| `coop-widened-autonomy-grant` before fix | 10/10 | **9 pass / 1 fail** |
| `coop-widened-autonomy-grant` after fix | 11/11 | 11/11 |

Full suite after: default 3201 tests / 3199 pass / 2 fail; controlled 487/487. Both failures are
pre-existing and reproduce on a pristine worktree at HEAD —
`test/coop-owner-response-linkage.test.js:306 byte 0x07` (a raw control byte in a file this work
never touched) and one `coop-main-lens-interaction` desktop/mobile UI assertion.

Also added `test/coop-owner-approval-friction.test.js`: 6 characterization tests that pin the
friction below as mechanical assertions, so the follow-up cannot land silently. Every assertion in
it was written from observed parser output, not from reading the regexes.

## (a) Why `request_task_input` cannot register a not-yet-delegated task

Not a bug in `request_task_input` itself; a missing state. The handler resolves every id through
`owningTask(parent, ids[i])` and returns `task not found` if the record is absent
(`lib/orchestration-tool-handlers.js:265-267`). Task records are only ever created by
`taskGraph.createTask`, reached from `delegate` or `plan`. So a task that has never been delegated
has no record, and there is nothing to move to `waiting_user`.

The deadlock is then exact. `pendingQuestionFor` requires a `waiting_user` record whose `clientRef`
is `portfolio:<taskId>:<revision>` (`lib/coop-pending-question-admission.js:117-140`). `clientRef`
is stamped at delegation from `input.clientRef || input.idempotencyKey`
(`lib/project-task-orchestrator-external-delegation.js:568`). To get the pending record you must
delegate; to delegate you need admission; the referential route is the admission you were trying to
reach. Brand-new work can therefore never use it.

`plan_task_graph` looks like a way out — it sets an arbitrary `clientRef` from `spec.ref`
(`lib/orchestration-tool-handlers.js:118`) without a dispatch. **It is not usable as-is**:
`createTask` sets `status: "queued"` (`lib/orchestration-task-graph.js:205`) and `plan` then calls
`deps.schedule(parent)`, so it would launch real worker sessions as a side effect of registering a
question. Fixable, but it needs a genuine non-scheduling placeholder state, not a repurposed one.

## (b) What would let Coop register the question before asking — and the trap in it

Mechanically small: allow a pending `waiting_user` record to be created for a portfolio ref that
has no task yet, and exclude that state from scheduling. Then Coop registers the question, asks it
in its own words, and the owner's natural first answer binds through the existing assent allowlist —
which, per the characterization test, already accepts "yes", "ok", "do it", "both", "1 and 2",
"go ahead", "proceed", "your call".

**Do not land it in that form.** It creates a new hijack vector of exactly the 2026-08-19 class.
Today the pending record is trustworthy because it can only describe work that was already
delegated. If Coop can mint one for arbitrary work, then a record registered *without the question
ever being put to the owner* turns the owner's next unrelated affirmative into authorization —
`answeringTurn` takes the first owner turn after `askedAt` and does not check that anything was
asked (`lib/coop-pending-question-admission.js:144-154`). That is the recency-based adoption that
produced ":482 / FIX!", rebuilt with better manners.

The missing invariant, and it is cheap: **require evidence that the question was actually asked.**
`session.history` carries `assistant_message` entries with `.text` (confirmed at
`lib/project-mate-interaction.js:428`), so admission can require an assistant turn containing the
registered `userQuestion`, positioned after registration and before the answering turn. That closes
the vector *and* is the thing that makes looser wording safe, because it restores the property the
whole subsystem rests on: the owner is answering something they demonstrably saw.

## (c) Why compound sentences bind only their first clause

Single-valued end to end, at four independent chokepoints. None is a truncation bug; all are
"return one thing".

1. **The verb match is `^`-anchored and non-global** —
   `imperative.match(/^(build|fix|implement|ship|deploy|code)\b/i)`,
   `lib/coop-thread-implementation-intent.js:85`. A verb in a later clause is never looked at.
2. **The one branch that reads past "and" collapses the pair into one intent.**
   `compoundImplementationDecision` (`:39-52`) requires the tail to be `and <verb> this|it|that`,
   returns `compound[2]` as the single intent, and uses the entire first clause `compound[1]` only
   as a veto filter. So the surviving clause is the *last* one here and the *first* one on path 1 —
   which clause is dropped depends on sentence shape. Observed:
   `"fix the anchors and backfill the ledger in clay"` → `{fix, clay}`;
   `"Backfill the anchors and fix it in clay"` → `{fix, clay}`.
3. **The record has one write-once singular field.** `normalizeImplementationDecision` returns one
   `{intent, source, at}` (`lib/coop-owner-request-records.js:213-219`, which also drops
   `projectName` entirely), and `lib/coop-owner-requests.js:383-386` keeps the first decision that
   reached disk forever. There is no `implementationDecisions`.
4. **The project capture is one non-global match anchored to `$`**, so the earliest `in|for|to`
   wins and swallows the rest (`:89`). `"Fix the anchors in lib/coop and the tests in clay"` yields
   `projectName: "lib/coop and the tests in clay"`, which resolves to no project and surfaces as
   `project_target_unavailable` (`lib/project-user-message.js:72-110`) — a wording failure reported
   as a target failure, which is why it is so hard to self-diagnose.

On the referential side the same shape appears as the first-sentence rule: `"Yes. Also do the other
one"` binds the answered question and drops the tail, and `"yes and also fix the tests"` is refused
outright rather than binding one half.

Can multi-task turns be supported safely? Yes, and the precedent already exists — **scopes and item
approvals are already plural** (`implementationScopesFor`, `lib/coop-owner-request-records.js:256-285`;
`explicitItemApprovals`, `lib/coop-item-approval.js:124-157`), with the singular kept only as a
legacy projection. The decision side would need a plural field plus relaxing the write-once at
`coop-owner-requests.js:386`. That is a schema change to a durable ledger and is not safe blind.

## (d) The real hijack risk, and what a looser model must preserve

This is the load-bearing conclusion. **The pending-record second factor with exact key equality is
sufficient on its own to prevent the 2026-08-19 hijack.** The hijack was a *selection* failure —
the turn was chosen by recency, never checked against the work — not a wording failure. Under exact
`clientRef` equality, "FIX!" for project `5332aafc` cannot authorize `b0c9b7a0` no matter how loose
the matcher gets. The 08-19 brief says this directly at `:218-227`: a second factor "makes
`build system is broken in clay` harmless **without needing to parse it**."

Must be preserved by any looser model:

- **The independently recorded pending snapshot plus exact key equality.** The one sufficient
  invariant.
- **A bounded candidate set.** Not necessarily "first turn only", but never "scan history for
  anything affirmative". With the second factor in place an unbounded scan reintroduces
  *ambiguity*, not cross-project hijack — so this is load-bearing for attribution, and only
  conditionally load-bearing against hijack.
- **Router proposes, admission re-derives.** The reason the revision widening was safe
  (`lib/project-task-orchestrator-external-delegation.js:314-330`).
- **The permanently-gated action list.** Orthogonal to hijack; keep it for irreversibility.

Merely conservative, given the above:

- **Whole-sentence anchoring, and the assent allowlist.** Empirically justified false-positive
  reducers *within* an already-narrowed candidate. Their 15 measured false positives were
  wrong-turn-as-assent errors, a much smaller blast radius than `:482`.
- **`REFUSAL` tokens, `BENIGN_TAIL`, bare-selection-needs-two.** Tuning artifacts.
- **First-sentence-only** is already conceded as a heuristic, not an invariant.

The strongest caution cuts *toward* loosening, not away from it. This subsystem has already caused
a refusal outage: 08-19 brief `:184-204` records ingresses 631/633 refused because they had no
leading imperative, while the owner's standing grant that did cover them was unreachable — it is
consulted ~88 lines after the `!request.coopTopicRef` return. The lesson drawn there was not
"tighten the regex" but "stop making the regex the only door".

Note the evidence asymmetry, which is why nothing in §(c)/§(d) was changed here: the 647-turn
corpus bounds **false positives** on one owner's phrasing in one transcript. It says nothing about
false negatives, which is the direction that has now bitten three times. And a prior tightening
attempt on this same parser was measured over a 170-case corpus, found harmful (46/100 real owner
commands newly refused), and reverted with "do not retry it".

## Recommended follow-up, in dependency order

The verb allowlist is the highest-value single change and the direct cause of the owner's reported
failure, but it is not in this task's owned paths and the standard this repo holds that parser to —
corpus measurement — is not reproducible, because **the 647-turn harness is not in the repo**. That
gap is the real blocker and should be closed first.

1. **Land the corpus harness in `scripts/`.** Until the measurement is re-runnable, no change to
   these parsers can meet the bar the last one met. Prerequisite for 2 and 4.
2. **Widen the verb allowlist** in `lib/coop-thread-implementation-intent.js:40,81,85` and
   `lib/coop-owner-request-records.js:215-216`, measured on the harness from 1. Candidates observed
   refused today: backfill, migrate, refactor, update, rewrite, add, remove, wire, port, patch,
   repair, finish. Deliberately **exclude** read-only words (review, audit, investigate, diagnose)
   — those belong to the read-only route and must not become implementation intents. The existing
   `/^(?:is|was|will|has|had|looks|seems)\b/` guard at `:88` and the mandatory `in <project>`
   already keep this to imperative, project-named turns. Expect `test/coop-owner-approval-friction.test.js`
   to fail; update it deliberately.
3. **Non-scheduling pending registration** (§a/§b), *with* the "question was actually asked"
   invariant in the same change. Shipping the registration without it widens authority.
4. **Plural decisions for compound turns** (§c). Largest and last: durable ledger schema change,
   relaxing a write-once field, plus fixing the greedy project capture at `:89`.
5. **Fix the owner-facing remedy text.** `lib/server-cross-project.js:1015-1035` tells the owner to
   say `"Fix <the thing> in <project>"` as though it were a generic shape, when it is verb-locked to
   six words; an owner following its spirit with any other verb gets an identical refusal with no
   hint that the verb was the problem. The fall-through at `:1197` carries no remedy text at all.

## Addendum, same day: the read-only review branch is an unbounded backward scan

A concrete symptom arrived after the above was written, and it is a *different and more serious*
defect in the same router. **FIXED** by owner decision, ingress 692 — see "The fix that landed"
below. The diagnosis is kept in full because the mechanism is subtle and the fix only addresses
the shadowing, not the unbounded scan underneath it.

> **Retracted:** an earlier revision of this section said this was "diagnosed to the line and
> reproduced in a test, but **not fixed**", and recommended the owner choose among three options.
> The owner chose option 3 (ingress 692) and it is now implemented. The three options and their
> trade-offs are left below because option 1 remains the unfinished work.

**Symptom.** From canonical Coop session `871a194b`, a `read_only_diagnosis` dispatch of
`clay-review-external-codex-recent-commits` rev2 was refused
`owner_implementation_decision_required: ingress coop:871a194b...:595 carries no owner
implementation decision, so no Thread can be bound to it` — while ingress 689 was the newest turn,
and while `read_only_diagnosis` is supposed to need no owner turn at all. The same shape had
succeeded earlier that day from a different session.

**It is not a stale or stuck ingress pointer.** Nothing is cached. Ingress 595 is the literal owner
text **"Do both"**, and it is selected fresh on every call by the backward history scan in
`currentExecutionRoute` (`lib/project-task-orchestrator-external-delegation.js:461-510`).

The mechanism, every step verified against live state:

1. `isReadOnlyReviewIngress(item, input)` (`:92-96`) is true for "Do both" —
   `PLURAL_OWNER_AUTHORIZATION` matches `do both`. Note it takes **`input`**: it is the read-only
   nature of *this dispatch* that pulls review-shaped turns into the candidate set, so the same
   history is harmless for a writable dispatch.
2. `explicitImplementationDecision("Do both")` is `null`, so `isImplementationIngress` is **false**.
   That is the bug, twice over:
   - the coverage guard at `:468` is written `if (!requested && isImplementationIngress(item))`, so
     **`unscopedIngressCoverage` never runs for a review ingress**. The review branch has no
     recency bound and no scope bound. This is the same unbounded backward scan the 2026-08-19
     ":482 / FIX!" hijack fix was meant to close — the bound was only ever wired to the
     implementation branch.
   - the Thread mint at `:497` also requires `isImplementationIngress`, so no Thread is minted and
     the route returns `{ coopIngressId: 595, coopTopicRef: null }`.
3. `implementationAdmission` refuses on its first line, `!request.coopTopicRef`
   (`lib/server-cross-project.js:1083`), and `missingThreadRefReason` produces the exact message
   above from `:1064-1068`.
4. Because the scan **returned**, `standingGrantExecutionRoute` — four routes further down at
   `:518` — is never consulted. **The exemption is shadowed by a route that could never have
   authorized anything.**

Live evidence, read-only from `~/.clay` (nothing mutated):

| ingress | text | expectsExecution | decision | topicRef | projectRefs |
|---|---|---|---|---|---|
| `:332` | "do them" | true | null | `auto-61f5ae911c79deab7fa6b255` | `[clay]` |
| `:595` | "Do both" | **false** | null | null | `[]` |
| `:689` (newest) | — | false | null | null | `[]` |

Session `871a194b` holds **689 owner turns and exactly two** review-authorization-shaped ones,
`:332` and `:595`. The scan runs backward, so it reaches `:595` first — that is the whole of why
"595". The session that succeeded (`93b6b284`) has **zero owner turns**, so its scan found nothing
and fell through to the grant. That is the whole of the session-dependence.

**Scope of impact.** Read-only dispatches specifically — a writable dispatch takes the
`isImplementationIngress` branch and does get the coverage guard. But within that scope it is
deterministic and unfixable by conversation: every `read_only_diagnosis` from this session whose
title or objective contains a `REVIEW_FRAMING` word will resolve `:595`, refuse, and shadow the
grant, no matter what the owner types next. An *implementation*-shaped newest turn does still win,
because the backward scan reaches it before `:595` — which is exactly the "two or three attempts
with the right phrasing" the owner reported, seen from the other side.

**Why it is not fixed here, despite being in this task's owned paths.** Three candidate fixes, and
the choice is a live authority decision rather than a bug fix:

- *Apply the coverage guard to review ingresses* (`:468` → `if (!requested)`). Closes the unbounded
  scan properly. But review dispatches never write a scope — `implementationAdmission` returns
  `{ok: true, reviewOnly: true}` at `:1156` **without** calling `scopeImplementation` — so coverage
  could only ever pass for the newest turn. That would newly refuse the 2nd..Nth review of a plural
  "do them", which is the exact flow `coop-read-only-review-admission` exists to serve.
- *Do not return a route that carries no Thread.* Strictly better than today, but insufficient:
  the scan would continue to `:332`, which **does** have a topicRef and `projectRefs: [clay]`, so
  admission would admit the review bound to a days-old unrelated Thread. Working for the wrong
  reason, and the hijack shape preserved.
- *Consult the standing grant before the scan when the dispatch qualifies.* Provably non-widening
  (the grant returns `{}` unless policy covers it, and admission re-derives it independently), and
  it fixes the symptom exactly. Cost: attribution — work an owner did ask for would run under a
  `grant:<taskId>` Thread instead of the owner's Thread.

My recommendation is the third, because it is the only one that cannot narrow existing authority,
plus the second as defence in depth. But it changes Thread attribution on a live path, and the
grant's reach depends on the owner's switch, so it should be an explicit decision.

## The fix that landed (owner decision, ingress 692)

Option 3. `standingGrantExecutionRoute` is now consulted in `currentExecutionRoute` immediately
after the ledger route and **before** the backward owner-turn scan
(`lib/project-task-orchestrator-external-delegation.js`).

One correction to the decision as written: it asked for the change "before the backward-scan-for-
owner-turn logic runs in `coop-pending-question-admission.js`". The backward scan is not in that
file. `coop-pending-question-admission.js` contains `answeringTurn`, a *forward* scan for the first
owner turn after a question, and it plays no part in this bug. The scan that adopts ingress 595 is
`currentExecutionRoute` in `project-task-orchestrator-external-delegation.js`, which is where the
fix went. The intent was unambiguous, so it was implemented rather than re-queried.

Four properties, in the order they matter:

1. **Grants nothing new.** The route only *proposes* a container; `implementationAdmission`
   re-derives the grant independently from the same policy file, so a route offered here is still
   refused there unless the policy really covers the dispatch.
2. **OFF is byte-identical.** Switch off, project not allowlisted, or a shape that is not fully
   read-only all return `{}`, and the scan then runs exactly as before. Asserted directly: with the
   switch off, the same stale-turn history produces the same refusal naming the same ingress 595.
3. **Only a grant that actually minted its Thread may preempt the scan.** A mint refusal keeps its
   original position at the end of the function. Promoting a refusal would let a failed policy read
   shadow a legitimate owner turn — the same shadowing defect in the other direction.
4. **The ledger route still wins.** A task-scoped owner record is exact evidence for this binding
   and is better attribution than policy, so it is resolved first, as before.

Accepted cost, exactly as flagged: for the narrow `read_only_diagnosis` class the grant now takes
credit ahead of the scan **and ahead of the queue and approval routes**, which sit below the scan.
Such work runs under a deterministic `grant:<taskId>` Thread instead of an owner turn's. Hoisting
the queue and approval routes above the grant would recover that attribution and was deliberately
not done unasked; it is a separate, larger reordering with its own regression surface.

> **Retracted:** this section previously ended by saying the review branch was "still an unbounded
> backward scan" and that option 1 was blocked. That was true of the narrow fix only. The full
> repair landed on owner decision, ingress 693 — see below — and the reorder described above has
> been reverted as part of it.

## The full repair (owner decision, ingress 693)

Option 1, done properly, plus the attribution recovery. Three changes that only work together.

**1. Review admission now records what it authorized.** `implementationAdmission`'s review branch
returned `ok` and wrote nothing, so nothing durable said which tasks a review turn had covered.
A new writer, `coop-owner-requests.scopeReview`, records one exact scope per binding into a
**separate** `reviewScopes` field.

The separation is the load-bearing part. A scope in `implementationScopes` *is* implementation
authority — every admission boundary reads it that way — so a read-only "do them" must never be
able to write one. `scopeImplementation` already refuses without an implementation decision
(`coop-owner-requests.js:417-420`), and `scopeReview` is deliberately not a way around that: it
never requires, sets or reads `implementationDecision`; never touches `implementationScope`,
`implementationScopes` or `expectsExecution`; and never widens `projectRefs` or mints a `topicRef`,
because those feed implementation admission's project matching. `normalizeRecord` had to be taught
the field explicitly, since it is a whitelist and would otherwise have dropped review coverage on
every reload. The write is best-effort: a failed write must not refuse a review the owner did
authorize, and the cost of losing it is a fallback to the newest-turn rule, not a wrong admission.

**2. The coverage guard now applies to review ingresses.** `:468` read
`!requested && isImplementationIngress(item)`; it now reads `!requested`. `unscopedIngressCoverage`
resolves review turns against `reviewScopes`, so the guard is passable for them rather than
vacuous. This is what closes the hijack: a review turn is now bound by the same rule implementation
turns already were — newest turn, or a durable scope naming this exact work.

It closes **both** stale classes, which matters because they need different discriminators:
`:595` ("Do both") authorized nothing at all, but `:332` ("do them") genuinely did — it has
`expectsExecution: true` and `projectRefs: [clay]`. Any bound based on "did this turn authorize
anything" lets `:332` through and attributes today's unrelated review to a days-old Thread. Only a
task-exact review scope excludes it.

**3. The ingress-692 reorder is reverted, recovering the attribution.** With the scan no longer
returning turns that cannot authorize, nothing shadows the routes beneath it, so the standing grant
is back in its original position and queue, approval and grant each keep their original precedence.
The accepted cost of the narrow fix is therefore paid back in full rather than merely disclosed.

### Migration cost, measured

**0 of 693 live ledger records carry `reviewScopes`**, because the field is new. So no existing
owner turn can supply review coverage until a review is dispatched against it while it is the
newest turn. Concretely: `:595` can no longer claim a route (the point), and `:332` can no longer
authorize *new* reviews either. Any in-flight plural "do them" review that had not yet been
dispatched will now be refused rather than resolved.

That is a genuine narrowing and it fails closed. It is acceptable here because `:332` is days old,
and because `read_only_diagnosis` in an allowlisted project — the common case — is covered by the
standing grant regardless. The residual gap is a read-only review that is *not* diagnosis-framed,
in a project the grant does not cover, authorized by a turn the owner has since spoken past: that
now needs a fresh owner turn.

### Verification

Proof by breaking, each half separately, since they guard different regressions:

| state | result |
|---|---|
| both halves in place | 41/41 |
| coverage guard reverted to `isImplementationIngress` | 39 pass / **2 fail** — the `:595` and `:332` class tests |
| review-coverage fallback disabled | 40 pass / **1 fail** — the plural-review non-regression test |

Full suite 3222/3224 default and 490/490 controlled, with the same two pre-existing failures that
reproduce on a pristine tree. `scopeReview` has its own tests for the authority property, the
idempotency, the additive plural case, and the reload round-trip.

### A second live-state leak found and fixed while doing this

`grantCoordinator` never passed `ownerRequests`, and every coverage check falls back to
`getDefaultOwnerRequests()` — the **real** ledger under `~/.clay/lead`. Since the ingress ids in
that test file are real ones (`INGRESS_332` is
`coop:871a194b-8879-40f7-a1fe-656e48e722af:332`), those tests were resolving coverage against
production state, so a local fixture could be silently contradicted by whatever the live ledger
held. The harness now threads its own ledger through to the coordinator. Same defect class as the
shipped-autonomy-policy leak fixed earlier the same day, and it was only caught because a new test
failed for a reason that made no sense against its own fixture.

Reproduced mechanically in `test/coop-thread-execution-admission.test.js`, "REPRODUCTION: a stale
review-shaped turn shadows the standing grant", with a control that differs **only** in that no
turn is review-shaped and which is admitted with a grant-minted Thread. The test currently asserts
the defect and must flip when the branch is bounded. Worth recording: the first version of that
test did not reproduce and passed for the wrong reason — `grantDispatch()` is titled
"Diagnose…/Investigate…", and neither word is in `REVIEW_FRAMING`. The collision requires the word
"review", which the real task title happens to contain.

## What this task did NOT cover

No live daemon exercised any of this. The landed fix is test-only and changes no admission
behavior, so no dispatch path was re-verified — it is evidence that the suite no longer depends on
the shipped switch, and nothing more. The friction itself (§a–§d) is diagnosed and reproduced but
**not fixed**; items 1–5 above are all still open.
