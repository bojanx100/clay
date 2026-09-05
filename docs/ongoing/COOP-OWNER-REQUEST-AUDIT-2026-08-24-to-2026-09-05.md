# Coop owner-request audit — 2026-08-24 to 2026-09-05

This is the corrected, canonical 24-row request-to-outcome audit. The complete
machine-readable row payload is the adjacent
[JSON appendix](COOP-OWNER-REQUEST-AUDIT-2026-08-24-to-2026-09-05.json).
The two artifacts were reconciled against the persisted owner-request index,
execution bindings, session ledger, and result ledger on 2026-09-06.

## Reading the matrix

`system-lead/<sessionStorageId>/<eventIndex>` is a RequestRef. ProjectRefs are
shown without abbreviation: `system-lead`, Clay
`5332aafc-31e7-5cb1-ba96-c8d90e78260e`, and where relevant Webapp
`b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9`. A completed binding records technical
work only; it does not itself prove integration, owner acceptance, or live
activation. Every row below records those distinctions and the next action.

The early `871a194b-8879-40f7-a1fe-656e48e722af` ingresses are present only in
the transcript and not in `coop-owner-requests.json`; their canonical
`eventIndex` values are unavailable. They are marked missing, not guessed.

## Canonical rows

### 1. Reconcile stale, failed, and open Coop/project sessions

RequestRefs: `system-lead/13135c7c-c9f6-44ea-8224-cf5bd7153dbd/60`; missing
indexed transcript refs `system-lead/871a194b-8879-40f7-a1fe-656e48e722af`
sequences `726`, `731`. ProjectRefs: `system-lead`,
`5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/06b12b3e-5c16-4772-9610-817a99eecd7b`.
Task/binding: `clay-reconcile-four-historical-coop-sidebar-sessions-20260902`
r2 completed; result `project-coordinator-7a2cb617-57e3-496c-a7d6-68a4e71daa22`.
Outcome: completed reconciliation (ledger seq 138); no owner-acceptance record;
later sidebar defects are separate rows. Next: none.

### 2. Make switching responsive without losing composer input or visible sends

RequestRefs: `system-lead/5603a204-ca0c-46d3-870d-b94a08936e2f/3077`,
`system-lead/5603a204-ca0c-46d3-870d-b94a08936e2f/3104`,
`system-lead/5603a204-ca0c-46d3-870d-b94a08936e2f/3139`; missing indexed
transcript refs `system-lead/871a194b-8879-40f7-a1fe-656e48e722af` sequences
`733`, `734`. ProjectRef: `system-lead`. Task/binding/session: missing—no
terminal typed binding covers the combined symptom. Outcome: unresolved. Next:
run a real switch acceptance path for composer preservation, visible send, and
incremental history loading.

### 3. Restore durable Main/Cop history and meaningful context

RequestRefs: `system-lead/04f7840c-b76e-498b-ac8d-cd54ac8cb1f2/163`,
`system-lead/04f7840c-b76e-498b-ac8d-cd54ac8cb1f2/235`,
`system-lead/2dbabddc-ab6e-45b0-b5fd-9c6ddb457377/155`,
`system-lead/2dbabddc-ab6e-45b0-b5fd-9c6ddb457377/164`,
`system-lead/2dbabddc-ab6e-45b0-b5fd-9c6ddb457377/186`,
`system-lead/aff0aac3-2173-459c-8180-a112c947f541/221`. ProjectRef:
`system-lead`. Task/binding/session: missing—multiple repairs exist, but no
typed terminal outcome covers all clusters. Outcome: unresolved. Next: create
one evidence-bound reconciliation retaining every source ref.

### 4. Make Coop and worker activity visible in Workspace/sidebar

RequestRefs: `system-lead/6a8bf999-9891-42ef-bae2-b5caf99b5a59/118`,
`system-lead/2dbabddc-ab6e-45b0-b5fd-9c6ddb457377/194`,
`system-lead/2dbabddc-ab6e-45b0-b5fd-9c6ddb457377/218`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/1b9e291b-51a8-4804-9c35-8bfa2b63f8f9`.
Task/binding: `clay-fix-workspace-sidebar-owner-work-visibility-20260828` r1
completed; result `project-coordinator-c0505b93-e1c9-4e4f-b6cb-c37a71c49d55`.
Outcome: technical/integration completion at ledger seq 500 (`8d06bb5953`);
owner acceptance and live activation are not separately recorded. Next: none.

### 5. Eliminate repeated/no-change Main notifications

Missing indexed transcript refs: `system-lead/871a194b-8879-40f7-a1fe-656e48e722af`
sequences `724`, `725`, `730`. ProjectRef: `system-lead`. Task/binding/session:
missing. Outcome: unresolved; no typed completion binding. Next: add and run a
real one-notification-per-unchanged-state acceptance test.

### 6. Improve the narrower project-coordinator workflow

RequestRefs: `system-lead/eeec139e-6e49-47a9-81e7-332a905fd75b/519`,
`system-lead/eeec139e-6e49-47a9-81e7-332a905fd75b/576`,
`system-lead/eeec139e-6e49-47a9-81e7-332a905fd75b/631`. ProjectRef:
`system-lead`. Task/binding/session: superseded by row 7. Outcome: superseded;
do not reopen as a duplicate.

### 7. Define the owner/Coop/project-coordinator/worker hierarchy

RequestRefs: `system-lead/8186936f-b53c-4253-ace0-7a2eccf5b0e0/30`,
`system-lead/8186936f-b53c-4253-ace0-7a2eccf5b0e0/62`,
`system-lead/8186936f-b53c-4253-ace0-7a2eccf5b0e0/95`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/71`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/82`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/92`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/130`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/148`,
`system-lead/019470ef-205b-4bdf-b291-5f818a67dbd7/177`,
`system-lead/a27af4e7-eb25-40dd-81db-7696bea5eba2/49`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/30d56554-af15-484c-ae61-5448ffcb3b4d`.
Task/binding: `clay-coherent-role-routing-and-project-coordinator-control-20260828`
r3 completed; result `project-coordinator-59d63000-3082-4c0f-b7c7-1be279f60d14`.
Outcome: qualified technical completion; mobile visual canary is missing
(`visual_canary_browser_unavailable`). Next: provide a controllable narrow
browser surface.

### 8. Fix mobile voice truncation and repetition

RequestRef: `system-lead/5440e5f2-f7da-4729-b796-33ed40987351/323`.
ProjectRefs: `system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/fb07ed27-6ed5-453f-ab4c-b1ec6ab0e7d9`.
Task/binding: `clay-mobile-voice-truncation-repetition-diagnosis-2026-08-25` r1
completed; result `project-coordinator-b0e4d89a-01ad-43fc-a263-29562ea6bf8b`.
Outcome: diagnosis complete, repair/live-device proof missing. Next: test real
capture; voice fragments remain evidence, not tasks.

### 9. Add truthful Workspace grouping controls and stable icons

RequestRefs: `system-lead/24536ded-449f-4752-9426-09e54a1585ca/35`,
`system-lead/fc6e4018-21f9-46e3-821a-23acb1e9582d/81`,
`system-lead/a5190b6a-7e01-44fc-a33b-d085e146155d/140`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRefs:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/1a14436f-95e9-45cd-9579-4ebf5fd9fccd`,
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/65a2e069-dc7e-43c5-bc9e-61f94e520500`.
Task/binding: `clay-workspace-collapsible-groups-20260829` r1 completed; result
`project-coordinator-155550c8-af49-41bd-b8db-a5f14bb5716f`; related bindings
are in the appendix. Outcome: completed binding chain; no separate acceptance
or runtime proof. Next: none.

### 10. Fix task-card layout and exact target-session activation

RequestRef: `system-lead/071b9131-a6d6-40f1-8147-b57d8fbab086/44`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/64e9d009-5ce7-426f-a25f-f6433989b05d`.
Task/binding: `clay-fix-coop-sidebar-card-and-session-activation-20260902` r2
completed; result `project-coordinator-614fa44e-5252-46a2-9f16-04e7d0b9f8c4`.
Outcome: qualified completion—r1 failed, r2 corrected it, but live UI proof is
absent. Next: rerun exact-session activation in the UI.

### 11. Repair restart/outage recovery, failover, stuck work, and usage reporting

RequestRefs: `system-lead/1133c69e-ce5c-4c1b-9dff-8d29a2001d89/77`,
`system-lead/1133c69e-ce5c-4c1b-9dff-8d29a2001d89/362`,
`system-lead/53c82bee-3adc-4f18-8bc5-81c54f1cda84/1574`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/988a2c36-7c72-427b-a293-8f8b4313fe75`.
Task/binding: `clay-fix-session-recovery-continuation-and-stuck-work-20260903`
r3 completed; result `project-coordinator-d088aa4c-af65-4023-8601-4971c13bbe8d`.
Outcome: partial lineage gap—earlier portfolio revisions failed `scope_expansion`
and no successor edge proves the full original scope. Next: record that link or
reconcile remaining claims.

### 12. Prevent stale restaff/re-arm board launches

RequestRefs: `system-lead/53c82bee-3adc-4f18-8bc5-81c54f1cda84/1711`,
`system-lead/53c82bee-3adc-4f18-8bc5-81c54f1cda84/1717`,
`system-lead/5603a204-ca0c-46d3-870d-b94a08936e2f/956`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/b2844ff2-1100-4535-ac8b-47cd11af5ba9`.
Task/binding: `clay-revalidate-board-eligibility-at-restaff-20260903` r1
completed; result `project-coordinator-8bb85096-955f-4bf6-b92e-aa69112b57ed`.
Outcome: completed binding; no separate owner acceptance/live activation. Next:
none; leave primitive intake unchanged.

### 13. Repair approval dispatch and owner-request reference/link drift

RequestRefs: `system-lead/5603a204-ca0c-46d3-870d-b94a08936e2f/1228`,
`system-lead/bca44fce-bfff-444c-87a5-bbc8e373cb5f/420`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/042f5e68-4d42-4148-8862-6afcf168529a`.
Task/binding: `clay-fix-owner-request-ref-drift-and-link-cap-20260904` r1
completed; result `project-coordinator-99876207-a649-4d7a-beb9-12d9a5816343`.
Outcome: technical proof (13/13, 3915/3915, 573/573, store 528/528), but no r2
binding covers the full visible symptom. Next: reconcile it in one live path.

### 14. Clear terminal/duplicate Webapp records from active sidebar projections

RequestRefs: `system-lead/62402eb7-8afc-40fb-8bca-c0d722a9cf95/1140`,
`system-lead/62402eb7-8afc-40fb-8bca-c0d722a9cf95/1903`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`,
`b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/cc6826c0-b708-40da-a019-6d63f0c56148`.
Task/binding: `webapp-sidebar-terminal-records-never-cleared-20260904` r1
completed; result `project-coordinator-e13995c5-6bc9-4242-b203-3dd6a474b0a5`.
Outcome: completed with ledger seq 1574 projection reverification; #2725 caveat
resolved. Next: none.

### 15. Enforce Coop-only top-tier routing without degraded fallback

RequestRefs: `system-lead/62402eb7-8afc-40fb-8bca-c0d722a9cf95/1948`,
`system-lead/62402eb7-8afc-40fb-8bca-c0d722a9cf95/2052`,
`system-lead/62402eb7-8afc-40fb-8bca-c0d722a9cf95/2170`,
`system-lead/8cefba33-c339-4689-a56c-a32932325aff/1169`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/7936c13f-7888-4fe8-8037-7af43139c88e`.
Task/binding: `clay-enforce-coop-top-tier-model-policy-20260904` r2 completed;
result `project-coordinator-574756bf-6e1d-4782-acbd-0aeab66216cf`. Outcome:
`f1a1ca12fb` on `origin/bojan`; ledger seq 1605 records 3967/3967, 577/577,
48/48. Owner approved r2; final acceptance/runtime proof is not separately
recorded. Next: none.

### 16. Restore Lead-ON auto-launch parity

RequestRefs: `system-lead/79255fc3-4cb1-4f09-899f-93c1b6fb0d48/341`,
`system-lead/79255fc3-4cb1-4f09-899f-93c1b6fb0d48/1971`,
`system-lead/f8443f30-d357-4009-a6e1-30d551f4b57d/741`,
`system-lead/0dd6d268-bf30-4640-bb4a-6a169c6bf75c/76`,
`system-lead/a300f34c-9852-4a13-81cb-e82ec94ef42f/1888`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/3c90be2c-c97d-49c5-8329-36d698cea061`.
Task/binding: `clay-fix-lead-on-auto-launch-end-to-end-20260904` r3 completed;
result `project-coordinator-fd808bdb-601a-4467-80b2-8507a0c9a88d`. Outcome:
ledger seq 1767 records `369d97a605`, `b7a63653e4`, `ffe8c339f1` on
`origin/bojan` and 103/103 focused checks; no separate real-board observation.

### 17. Make scoped auto-approvals effective

RequestRef: `system-lead/a99b95b9-62db-4e8c-a270-24508cf0c8d9/694`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/8cfc2d20-cf05-43cc-b57a-89c195ab914e`.
Task/binding: folded into `clay-fix-lead-on-auto-launch-end-to-end-20260904` r2
completed; result `project-coordinator-089b2121-6007-4d03-a420-5e9c91ea4f8a`.
Outcome: completed as folded scope (ledger seq 162, 48/48). Next: no duplicate.

### 18. Schedule provider-reset continuation after quota exhaustion

RequestRefs: `system-lead/8cefba33-c339-4689-a56c-a32932325aff/1216`,
`system-lead/f8443f30-d357-4009-a6e1-30d551f4b57d/626`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/19db01df-d217-4b19-8e2f-0f6928d9f611`.
Task/binding: `clay-schedule-reset-continue-on-budget-exhausted-20260904` r1
completed; result `project-coordinator-72239ca9-1f51-42ac-8e9f-b6a9653a64d5`.
Outcome: `d0c20acdf7` on `origin/bojan`, 47/47 focused verification; provider
preference superseded. Next: none.

### 19. Terminalize auto-launched change-review sessions

RequestRefs: `system-lead/3749f35b-8700-493a-ab37-892d219cddaf/673`,
`system-lead/3749f35b-8700-493a-ab37-892d219cddaf/714`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/09f3356d-00af-494e-ba6f-74f193c9861c`.
Task/binding: `clay-remove-owner-acceptance-for-pr-auto-launch-20260905` r2
completed; result `project-coordinator-ebbee906-4e14-470b-8698-e82b60834fa2`.
Outcome: revert proof is 31/31 restored versus 29/31 reverted. Unintegrated r1
`dc34add24c` is history, not an open duplicate. Next: none.

### 20. Auto-approve ordinary Clay and Coop work when Clay is On

RequestRefs: `system-lead/3749f35b-8700-493a-ab37-892d219cddaf/757`,
`system-lead/3749f35b-8700-493a-ab37-892d219cddaf/758`,
`system-lead/000c761a-64f7-4be5-a04b-f21cb39a85a3/542`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/70208cf5-fc99-426e-b3de-f1b3b79766c6`.
Task/binding: `clay-auto-approve-all-ordinary-clay-coop-work-20260905` r1
completed; result `project-coordinator-1fe345e0-af84-4c54-9225-ce41ade0c118`.
Outcome: `e15c13d739` on `origin/bojan`, 210/210 acceptance tests; scope was
authorized but final acceptance is not separately recorded. Next: none.

### 21. Make Coop persistently proactive

RequestRefs: `system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/48`,
`system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/129`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/329ed81e-cb61-4a98-81b4-aa87ed2bdd60`.
Task/binding: `clay-make-coop-proactive-by-default-20260905` r1 completed;
result `project-coordinator-d616015c-64ac-47bd-9958-73dadc51cba2`. Outcome:
qualified completion (41/41 focused, 49/49 cross-project, 18/19 revert proof),
but an unrelated full-suite baseline is not clean. Next: keep qualified.

### 22. Fix compact, readable Triage and Council sidebar cards

RequestRef: `system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/192`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/3a6f136c-af2d-4404-99b4-9dc5fdc80f1f`.
Task/binding: `clay-fix-triage-council-sidebar-cards-20260905` r3 completed;
result `project-coordinator-1390fdf8-4df8-4164-bb01-5b5ba378abf9`. Outcome:
r1 restart recovery, r2 recovery, r3 visual completion; no separately retained
visual artifact or final owner acceptance. Next: capture proof if challenged.

### 23. Add a truthful Workspace Tasks view

RequestRefs: `system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/218`,
`system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/243`,
`system-lead/6c796d20-abf3-4481-b33f-742f50eca909/263`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRefs:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/72a88022-8953-40ed-bd44-c51e1576b482`,
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/ef8e3dd7-c179-4698-8ae7-0119d99a9aba`.
Task/binding: `clay-workspace-all-tasks-tab-20260905` r6 superseded; r2/r3/r5
completed, r4 needs input, r6 stopped on native active-writer lock. Outcome:
implementation evidence is 12/12, 22/22, 2/2, but typed source provenance and
live activation are unresolved. Next: thread provenance and activate without
the native lock.

### 24. Deliver this two-week owner-request outcome audit

RequestRef: `system-lead/8616398d-7644-4ca4-8ec1-f6dbb6117883/227`. ProjectRefs:
`system-lead`, `5332aafc-31e7-5cb1-ba96-c8d90e78260e`. SessionRef:
`5332aafc-31e7-5cb1-ba96-c8d90e78260e/f630ef22-42db-4e40-89ca-32511e53fdf5`.
Task/binding: `clay-audit-two-weeks-unhandled-owner-requests-20260905` r4
active; source session `system-lead/d800641e-af4b-4dde-a7a2-66eeeafe989f`.
Outcome: r1 failed `restart_recovery`, r2 was incomplete, r3 was superseded for
UUID corruption; r4 is this corrected delivery. Next: validate, commit, push.

## Validation contract

The appendix validator must assert exactly 24 unique rows, parseable JSON,
every present RequestRef resolves in `coop-owner-requests.json`, every project
and session reference exists in the applicable record, every non-null binding
task/revision resolves in `portfolio-execution-bindings.json`, and every absent
RequestRef has an explicit reason. This documentary check does not exercise
application behavior; historical test counts above are outcome evidence only.

Validator output against the stored records:

```
rows=24
requestRefs=65
missingRequestRefGroups=3
bindings=20
markdownRows=24
validation=pass
markdown-json-reference-agreement=pass
```
