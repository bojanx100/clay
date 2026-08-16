# Coop Thread promotion and Urban Stay auto-launch repair

## Symptom

Owner ingress 406 contained an explicit final command to start a Clay implementation Thread for the Urban Stay auto-launch regression, but the durable transcript and owner-request ledger recorded it as conversational with no TopicRef, ProjectRef, or execution decision. Urban Stay's independent `assigned: "any"` collection policy also had to remain a no-assignee filter rather than become the unsupported literal GitHub login `any`.

## Root cause

Canonical Main scope returned conversational before canonical ingress classification. The implementation-intent parser also did not recognize the strict `Start a Clay implementation Thread for ...` command when it followed an earlier paragraph. The collector already correctly interpreted `any`; coverage did not prove that it remained independent from Webapp's `assigned: "me"` policy or that an admitted Urban Stay candidate retained its canonical ProjectRef.

## Fix

- Recognize a strict final-paragraph implementation-Thread command, resolve its named project from the accessible project list, and classify the explicit subject into a new project-bound canonical Thread.
- Keep ordinary Main conversation route-free and refuse an unavailable or ambiguous named project.
- Add a finite SHA-256-verified repair for ingress 406. It creates only `recovery-urban-stay-autolaunch-406`, grouped under the Clay ProjectRef, adds only the exact canonical event membership, and then backfills the Clay implementation decision. It never mutates the source event or launches work.
- Route recovered admission aliases only for that exact event and Thread; retain the established Voice and Threads recovery paths.
- Keep `assigned: "any"` as no `--assignee` flag, while preserving Webapp's `--assignee @me`, and bind admitted Urban Stay candidates only to Urban Stay's ProjectRef.

## Evidence

- Focused ingress, admission, recovery, and policy tests passed: 49/49.
- `npm test` passed in full.
- A dry-run against temporary copies of the live canonical transcript and topic index proved the finite repair creates the expected Thread and backfills `expectsExecution: true` with only Clay ProjectRef `5332aafc-31e7-5cb1-ba96-c8d90e78260e`; live durable files remained unchanged.
- No daemon was active and no Urban Stay candidate/binding was present, so no live work was launched. The existing startup migration and canonical ProjectRef admission path will safely resume eligible work after activation.

## Status

DONE — the repair is exact, restart-safe, scoped to the canonical command, and covered by the full repository suite.
