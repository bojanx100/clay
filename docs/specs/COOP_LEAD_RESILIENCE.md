# Coop and project-lead resilience

Status: **specified, not implemented.** Staged as the next admitted Clay work item, to start once the owner-topic execution flow is READY.

Owner ingress 194 (durable learnings, deterministic rehydration, identical lifecycle) and 195 (unify with provider-switch continuity).

One minimal hook is already landed, because the current release would otherwise block the recovery this spec describes: `coopOwnerRequests.transferCoordinator`, in `lib/coop-owner-requests.js`. Everything else below is unbuilt.

---

## Why a hook was needed before the spec

Coordinator cardinality is keyed on the coordinator's session storage id. A replacement session on the same binding therefore reads as a **rival** and is refused, and with the strict claim-verdict handling added this round its execution is marked `unavailable`. The cardinality rule would reliably block the rehydration it is meant to protect.

`transferCoordinator({ topicRef, projectRef, from, to, reason })` is the narrow exception: same topic, same project, **named predecessor**, exactly one coordinator afterwards. Naming the predecessor is what makes it safe — a transfer can only replace the coordinator the caller believes is there, so it cannot steal a pair or invent a claim that was never held. It fails closed on a write failure with the incumbent intact.

That is the whole hook. It does not checkpoint, rehydrate, or switch providers.

---

## 1. Durable evidence-backed learnings

### The failure this prevents

A model concluding something in a turn is not knowledge. Today those conclusions live only in transcripts, so they are either lost or re-derived — and when re-derived they are as likely to be wrong as right. The opposite failure is worse: treating a free-form conclusion as permanent truth, which is how a single bad inference becomes policy.

### Record

Reference-only, exactly like the topic index and the owner-request ledger. Persisted at `~/.clay/lead/coop-learnings.json`, schema `clay.coop_learnings`.

| Field | Meaning |
|---|---|
| `learningId` | Content-addressed over scope + normalised claim; stable across restarts |
| `scope` | `global` \| `coop` \| `project` \| `topic`, with the matching `ProjectRef` / `TopicRef` |
| `claim` | Bounded statement, ≤ 500 chars |
| `kind` | `observation` (evidenced fact) \| `normative` (a rule that changes behaviour) |
| `evidence[]` | Canonical event refs, commit sha, test name, file:line. **Never prose.** |
| `confidence` | `observed` \| `corroborated` \| `owner_confirmed` |
| `recordedAt`, `recordedBy` | Timestamp and the session ref that recorded it |
| `version` | Increments on amendment; prior versions retained |
| `supersededBy` / `retractedAt` / `retractionReason` | Terminal, never deleted |
| `ownerApproval` | Required for `kind: normative`; `{ status, at, ingressId }` |

### Rules

- **A normative learning without `ownerApproval.status === "approved"` is inert.** It is recorded and visible, and it changes nothing. This is the rule that stops model conclusions becoming policy.
- **Evidence is references, never prose.** A learning whose evidence array is empty cannot rise above `observed`.
- **Supersession, not mutation.** Correcting a learning writes a new version and points the old one at it, so how the system's belief changed stays auditable.
- **Retraction is first-class.** A retracted learning is excluded from rehydration but retained as evidence that it was once believed.
- Scope resolution is narrowest-first: `topic` → `project` → `coop` → `global`. A narrower learning shadows a broader one; a *contradiction* between scopes surfaces as owner attention rather than being silently resolved.

### Seam

`lib/coop-learnings.js` (store) + `lib/coop-learning-scope.js` (resolution). Read by the rehydration packet builder. No other read path in phase 1 — a learning that nothing consumes is easier to get right than one wired into live routing.

---

## 2. Deterministic rehydration

### Triggers, and the distinction ingress 195 insists on

**(A) Provider capacity or health failure, context healthy → switch the route, keep the session.**
Already largely served by the existing provider-switch path. No new session, no handoff, no checkpoint. The session identity, its native thread and its context are all fine; only the route is unhealthy.

**(B) Context exhaustion, wedged native thread, repeated empty turns, reasoning corruption → checkpoint and continue in a fresh session.**
The session itself is the problem, so switching its route cannot fix it. This is where rehydration applies.

Conflating these is the trap: (A) treated as (B) throws away a healthy session and its context for no reason; (B) treated as (A) moves a wedged thread onto a healthy provider and stays wedged.

### Detection

| Signal | Source | Class |
|---|---|---|
| Route unhealthy / capacity exhausted | `provider_health` in `~/.clay/recovery-events-dev.log` | A |
| Context above threshold | `context_usage` events | B |
| N consecutive turns with no assistant output | the `ASSISTANT_OUTPUT` rule already in `coop-conversation-control.js` | B |
| Turn-done with no progress on the task graph | orchestration task state | B |
| Owner explicitly says it is stuck | owner ingress, classified | B |

The empty-turn signal deliberately reuses the answer rule this release already established: a `done` with no assistant output. That rule found 53 unanswered owner requests; it is the same evidence, read for a different purpose.

### The rehydration packet

Compact and derived — **never a transcript replay**. Replaying a noisy transcript is what produced the wedged session in the first place.

1. **Objective** — the admitted task objective, verbatim.
2. **Accepted decisions** — owner-approved decisions on this topic, from the disposition record.
3. **Task graph ownership** — open tasks, their status, and which are this coordinator's.
4. **Verified artifacts** — commit shas, pushed branch, passing test counts. Claims with evidence, not summaries.
5. **Outstanding owner requests** — straight from the owner-request ledger, unanswered first. *This is the load-bearing one: the whole point is that a replacement coordinator knows what the owner is still owed.*
6. **Applicable learnings** — scope-resolved, retracted ones excluded, normative ones only if owner-approved.
7. **Pending fan-in events** — undelivered results from `~/.clay/coop-fanin/`.

Bounded, and every element traceable to a durable record. If an element cannot be sourced from a durable store it does not go in the packet.

### Atomic handoff

```
checkpoint(old)                       -> immutable checkpoint record
create(new, same ProjectRef binding)  -> fresh session, no transcript
transferCoordinator(from: old, to: new)  -> the landed hook
transfer task-graph ownership         -> atomic with the claim
seal(old)                             -> superseded, MUST NOT process further
deliver(packet -> new)
```

Ordering matters for the same reason it did in the merge fix: the fail-closed step goes first. If `transferCoordinator` refuses, nothing has moved and the old session is still the coordinator.

**Idempotent handoff identity**: `handoffId = hash(bindingRevision, oldSessionRef, reason)`. A replay finds the completed handoff and returns it rather than creating a second successor. This is what prevents duplicate workers, duplicate tasks and duplicate owner requests.

**Sealing is mandatory.** The old session becomes immutable superseded evidence. If it can still process a turn, both sessions can answer the owner and the ledger gets two answers for one request. Sealing must be enforced at the ingress seam, not by convention.

### Rollback

If any step after the checkpoint fails, the old session is un-sealed and the claim transfers back — `transferCoordinator` is symmetric and already fails closed. A handoff that cannot complete leaves exactly the state it started in.

---

## 3. Identical lifecycle for Coop and project leads

The same state machine, the same records, the same triggers. Coop is not special; it is a coordinator whose project is the Coop pseudo-project.

Two constraints that are easy to get wrong:

- **Coop's canonical TopicRef and its ingress lane survive rehydration.** The successor answers ingresses on the same lane, with the same `activeIngressId` semantics. `markAnswered` must attribute to the *original* ingress, not to a re-recorded one.
- **No Lead-local execution.** A rehydrated Coop coordinator still routes through typed `ProjectRef` bindings. Rehydration changes which session holds the work, never where the work runs.

**Audit trail**: every handoff writes `{ handoffId, reason, class (A|B), trigger evidence, from, to, at, outcome }`. The reason is a bounded code from a closed vocabulary, like every other attention code in this stack — not free text.

---

## 4. Verification the implementation must carry

Failing-first, and these are the ones that actually matter:

- No owner request is lost or duplicated across a handoff — count and identity preserved, `unanswered()` identical before and after.
- No duplicate workers or tasks: replaying the same `handoffId` produces one successor.
- A sealed session cannot process a turn, cannot mark answered, cannot claim.
- Class A does **not** create a new session; class B does.
- Rollback from a failed handoff restores the exact starting state.
- A normative learning without owner approval changes no behaviour.
- Retracted and superseded learnings never reach a rehydration packet.
- Coop and a project coordinator produce byte-identical handoff records given the same inputs.

---

## Staging

Phase 1 is learnings (self-contained, no live consumers). Phase 2 is checkpoint + packet + sealed handoff. Phase 3 is trigger detection and automatic recovery. Each phase is independently landable and independently reviewable; none of it starts before the current flow is READY.
