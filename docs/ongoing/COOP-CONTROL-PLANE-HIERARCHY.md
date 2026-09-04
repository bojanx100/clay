# Coop control-plane hierarchy

This note records the owner decisions recovered through binding revision 7. The
requested handoff Markdown file was absent; the same canonical conversation is
preserved in
`~/.clay/sessions/-Users-bojansubotic--clay-lead-workspace/871a194b-8879-40f7-a1fe-656e48e722af.jsonl`.
The ingress sequence and timestamps below are the durable anchors.

## Owner anchors

- Ingress 17, 2026-08-06 12:27:23 UTC: the owner requested a shared
  multi-model triage with Fable and two Sol perspectives. The accepted design
  named this shared adjudication surface Council.
- Ingress 230, 2026-08-13 12:50:46 UTC: project coordinators should appear as
  Coop workers while ordinary projects "stay like always"; multiple task
  coordinators report to project coordinators.
- Ingress 249, 2026-08-13 21:44 UTC: "I want project coordinators in coop
  sidebar." Persistent project rows remain while completed children may hide.
- Ingress 252, 2026-08-13 22:15 UTC: project-side placement was rejected;
  coordinators belong in Coop and project sidebars remain unchanged.
- Ingress 258, 2026-08-14: coordinators classify project work as done, working,
  or attention while preserving active, blocked, and owner-direct evidence.
- Ingress 259 proposed Exploring, Parked, Handed off, and Closed. This was an
  exploratory proposal, not the final lifecycle decision.
- Ingress 261, 2026-08-14 13:01 UTC: remove categorisation; use direct names such
  as `Clay coordinator` and `Webapp coordinator`; Threads use colored status
  dots with tooltips.
- Ingress 262: task coordinators are sessions and their worker sessions may be
  nested below them.
- Ingress 299, 2026-08-15 09:11:40 UTC: open Threads do not require matching
  project sessions. Undecided or needs-more-decisions work stays in Threads;
  Implement moves it to the project coordinator and removes it from Threads;
  Do not implement deletes it.
- Ingress 300, 2026-08-15 09:13:57 UTC: remove `Uncategorised`, `Clay`, and
  `Webapp` category groups; show Threads and project-named coordinators, with
  worker sessions below task coordinators such as `Verify activated fixes`.
  The owner explicitly questioned whether Closed is needed.
- Ingress 301, 2026-08-15 09:16:50 UTC: actual projects do not show the
  persistent/generic project-coordinator parent. Their task coordinators and
  sessions are ordinary top-level project items.
- Ingress 302, 2026-08-15 09:17:39 UTC: Coop manages project coordinators and
  talks to the owner; project coordinators assign work to project sessions.
- Ingress 303, 2026-08-15 09:18:45 UTC: Coop, project coordinators, Council, and
  Triage are sessions that live in Coop.
- Ingress 304, 2026-08-15 09:19:44 UTC: project structure is identical with
  Lead mode on or off. Only the control path changes.
- Ingress 305, 2026-08-15 09:21:03 UTC: notify the owner only when the complete
  change has landed and is ready to test.
- Ingress 309: execution projects as `Project coordinator -> handed-off or
  implemented Thread -> one or more task coordinators/sessions`. The undecided
  Thread stays in top-level Threads; after a successful handoff, that same
  durable Thread becomes the container under the relevant project coordinator.
  Children may run independently, in parallel, or through explicit TaskRef
  dependencies. Actual project sidebars keep the target sessions in their
  ordinary top-level project structure.
- Ingress 310: Thread identity and classification are stable while automatic
  titles may improve from accumulated, proven owner conversation. Related and
  ambiguous follow-ups enrich the same Thread; unrelated named subjects mint a
  separate Thread. Manual titles are authoritative. Internal worker/fan-in
  records never supply title evidence, replay is idempotent, and handoff keeps
  the current refined title without changing ThreadRef, group, lifecycle, or
  execution bindings.

The supplied screenshot at
`~/.clay/images/-Users-bojansubotic--clay-lead-workspace/1786785237007-b52f226bbd5bf6e4.png`
captures the rejected Coop layout: `Uncategorised`, project category headings,
generic `Project coordinator` labels, and `Closed`. The screenshot at
`~/.clay/images/-Users-bojansubotic--clay-lead-workspace/1786785410293-28cdc7adb1a53c01.png`
captures the rejected project layout with a generic persistent coordinator
above the ordinary task coordinator. These are before-state evidence, not
alternate requirements.

## Revision 6 audit for ingresses 309–310

Commit `6f4cf56e5edf23c54b109e5e0b9dc98a73f6ee31` was reviewed clause by
clause rather than accepted from its revision report:

| Clause | Revision 6 evidence | Finding at 6f4 |
| --- | --- | --- |
| Undecided Thread stays top-level; successful handoff removes it | `coop-topic-management.js`, `coop-thread-lifecycle.js`, and `sidebar-coop-topic-model.js` already gated removal on `handed_off` | Implemented |
| Same Thread becomes a durable container beneath its project coordinator | `global-coop-coordinator-tree.js` projected coordinator → task coordinator → worker with no TopicRef node | Missing |
| Several independent/parallel/dependency-linked child coordinators with rollup and navigation | Multiple active children and exact SessionRef navigation existed, but dependency metadata, the Thread layer, and child execution-state rollup did not | Partial |
| Actual project sidebar remains ordinary/top-level and Lead-mode invariant | `sidebar-sessions-model.js` omitted the persistent root and did not branch on Lead mode | Implemented |
| Stable Thread identity | `coop-topic-classification.js` derived deterministic IDs and lifecycle mutations retained TopicRef/ThreadRef | Implemented |
| Related vs unrelated vs ambiguous classification | Reuse/mint/follow-up ladders existed, but the weak match treated inflected request verbs such as `needs` as subject evidence | Partial |
| Titles improve from accumulated proven owner conversation | `coop-topic-retrofit.js` was an exactly-once repair and could not evolve a live title | Missing |
| No first-turn freeze/latest-turn overfit/raw-prefix truncation/minor churn | Automatic titles stayed at the first bounded excerpt after the one-time retrofit | Missing |
| Manual-title authority and worker/fan-in exclusion | Manual protection and owner-relevance predicates existed, but no progressive title path consumed them | Partial |
| Restart/replay idempotence and handoff title preservation as the container | Index replay was idempotent, but there was no progressive audit and no Thread container to carry its refined title | Partial |

## Reconciliation

Ingresses 299–300 are later and more explicit than the Closed/archive proposal
in ingress 259. Therefore no Closed navigation group exists. A successful typed
handoff changes a Thread to `handed_off`, after which it leaves Threads. A
failed handoff leaves the Thread visible. Choosing Do not implement removes the
Thread record from the index while canonical conversation history remains.

Ingress 303 resolves the earlier ambiguity about persistence home: project
coordinator sessions live in the Lead/Coop project with an explicit target
`ProjectRef`. Task coordinators and workers live in the target project. The
observable execution hierarchy is:

`Coop project coordinator -> handed-off Thread -> target-project task coordinators -> target-project workers`

The Thread container is not a copied project record. Placement follows its
ACL-filtered durable execution `ProjectRef`s, so a cross-project or initially
uncategorised Thread can appear beneath each coordinator actually executing it
while its canonical ThreadRef and classification remain unchanged. A legacy
active task without a ThreadRef remains directly beneath the coordinator rather
than disappearing during migration.

The target project omits the control-plane root, so its task coordinator is an
ordinary top-level project session. Owner-direct sessions are never reparented.

## Progressive title invariant

Automatic titles are machine-managed only while their creation fingerprint or
prior machine-retitle audit proves that the owner has not renamed them. A title
change requires at least two proven owner turns and material multi-turn support;
minor acknowledgements, the latest unrelated turn, injected prompts, automation,
and task-notification fan-in are excluded. The selected title is a complete
owner clause within the title bound rather than an ellipsis-clipped prefix.

Retitling mutates only `title`, `updatedAt`, and bounded title-refinement audit
metadata. `TopicRef`/`ThreadRef`, grouping, membership, lifecycle state,
disposition, and related execution links remain byte-for-byte stable. The audit
stores a deterministic evidence digest and score, so replaying the same history
after restart is a no-op and weaker subsequent evidence cannot churn the title.

## Authority invariant

Canonical Coop may dispatch or steer only the Lead-resident coordinator whose
control-plane policy is bound to the requested `ProjectRef`. The target project
accepts a project-coordinator create command only when the envelope source and
the declared control-plane coordinator are the same Lead `SessionRef`, and the
command names the coordinator's durable task. The coordinator is the recorded
authority for target task creation, steering, retries, integration, and
verification. There is no Lead-local project worker or direct-leaf fallback.
