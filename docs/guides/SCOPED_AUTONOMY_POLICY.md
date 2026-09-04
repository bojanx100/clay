# Scoped automatic approval policy

This policy is the safe, persistent replacement for a blanket `approve all`
request. It lets Coop staff an already-admitted, low-risk backlog candidate
without asking the owner again for that candidate. It is not a general approval
or a way to turn an owner-gated project policy into autonomous execution.

## What is automatically admitted

All of these conditions must hold at admission and again at execution:

- The candidate is still pending, is owned by the exact granted `ProjectRef`,
  and has passed its current project policy and eligibility scan.
- The candidate was otherwise waiting only for `owner_approval`; a pre-existing
  owner discussion thread is never replaced by this policy.
- Its persisted, candidate-digested safety envelope says `risk: "low"` and has
  no retained hazard flag.
- The durable policy has one exact owner-provisioned grant for that project.

The candidate remains owner-gated in the project queue. Admission emits a typed
`coop_scoped_low_risk` authorization receipt that carries the current grant;
it does not reclassify the candidate as project-policy autonomous.

## Retained owner gates

The policy refuses and leaves the normal owner gate in place for destructive,
self-modifying, control-plane, security-sensitive, cross-project, and material
scope-expansion work. It also refuses missing, malformed, or unknown safety
evidence; stale project policy or eligibility; a changed candidate digest; a
foreign project; Lead mode off; and any unavailable policy record.

Configured external-action approval, claim, and deny gates remain unchanged.

## Owner provenance and provisioning

A grant can only be provisioned from a durable owner-request entry whose exact
canonical `user_message` event has real owner provenance and an implementation
scope for the policy's portfolio task. The stored grant contains references
(ingress, session, event index, project, and task), never approval text.
Consequently, a named task approval or an exact approval that lacks that
implementation scope cannot be repurposed as a broad policy grant.

Provision the grant once after the release is deployed, using the canonical
Coop history for the exact owner ingress:

```sh
node bin/coop-scoped-autonomy-policy.js \
  --owner-ingress <exact-ingress-id> \
  --authorization-task clay-scoped-auto-approval-policy \
  --owner-requests ~/.clay/lead/coop-owner-requests.json \
  --history <canonical-coop-session.jsonl>
```

The command atomically writes `~/.clay/lead/scoped-autonomy-policy.json` and
prints the reference-only grant. It refuses absent, injected, ambiguous, or
wrong-task evidence without writing a policy.

This is a durable live-state edit. Before provisioning, take the required
verified control-store snapshot (`node scripts/snapshot-control-store.js`) and
record the existing policy file as the rollback target. Re-read the written
grant immediately afterwards; rollback must restore only that policy record,
with owner approval for the durable edit.

## Deployment

Deploy the code, provision the exact grant, then restart the Clay daemon so the
running process loads this version of the admission and execution validators.
Until provisioning succeeds, the policy is empty and all owner-gated candidates
continue to require their normal owner decision.
