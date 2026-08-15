# Coop control-plane hierarchy

This note records the owner decisions recovered for binding revision 6. The
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

The supplied screenshot at
`~/.clay/images/-Users-bojansubotic--clay-lead-workspace/1786785237007-b52f226bbd5bf6e4.png`
captures the rejected Coop layout: `Uncategorised`, project category headings,
generic `Project coordinator` labels, and `Closed`. The screenshot at
`~/.clay/images/-Users-bojansubotic--clay-lead-workspace/1786785410293-28cdc7adb1a53c01.png`
captures the rejected project layout with a generic persistent coordinator
above the ordinary task coordinator. These are before-state evidence, not
alternate requirements.

## Reconciliation

Ingresses 299–300 are later and more explicit than the Closed/archive proposal
in ingress 259. Therefore no Closed navigation group exists. A successful typed
handoff changes a Thread to `handed_off`, after which it leaves Threads. A
failed handoff leaves the Thread visible. Choosing Do not implement removes the
Thread record from the index while canonical conversation history remains.

Ingress 303 resolves the earlier ambiguity about persistence home: project
coordinator sessions live in the Lead/Coop project with an explicit target
`ProjectRef`. Task coordinators and workers live in the target project. The
observable hierarchy is:

`Coop project coordinator -> target-project task coordinator -> target-project workers`

The target project omits the control-plane root, so its task coordinator is an
ordinary top-level project session. Owner-direct sessions are never reparented.

## Authority invariant

Canonical Coop may dispatch or steer only the Lead-resident coordinator whose
control-plane policy is bound to the requested `ProjectRef`. The target project
accepts a project-coordinator create command only when the envelope source and
the declared control-plane coordinator are the same Lead `SessionRef`, and the
command names the coordinator's durable task. The coordinator is the recorded
authority for target task creation, steering, retries, integration, and
verification. There is no Lead-local project worker or direct-leaf fallback.
