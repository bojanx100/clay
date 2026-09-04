# Durable Coop owner decisions and chat history (2026-08-28)

## Symptom

The canonical post-Council Lead tick asked the owner to choose whether to
accept or change plan defaults, but the choice existed only in assistant prose.
It therefore did not enter the owner Needs-you queue. After compaction, a
selected TopicRef could also omit that persisted assistant response from its
replay even though the predecessor transcript still contained it.

## Root cause

- `coop-owner-requests` intentionally accepts only canonical owner ingress;
  parsing an assistant message into a request would forge authority.
- The action queue did not enumerate the Lead project, where the canonical Coop
  task lives.
- **Retracted after the prerequisite diagnosis terminalized:** the earlier
  wording that lineage replay had no membership edge for the historical delta
  was too broad. A read-only calculation over the real three-session chain
  retained that delta in Main, so deletion and a Main-lineage omission are not
  supported. The demonstrated visible-loss risk is instead lens-dependent: a
  selected TopicRef can suppress an unrouted synthetic tick, while the missing
  durable decision still leaves nothing for Needs-you. The explicit response
  link below makes the relevant selected-topic behavior deterministic. Its
  normal repeated-progress-text dedupe also made an explicitly staged response
  vulnerable to an earlier identical tick sentence.

## Fix

- `coop-owner-decision-staging` now requires a typed immutable plan scope and
  creates a stable non-runnable `needs_input` task. It supports exact action,
  replacement by a newer plan revision, explicit withdrawal, independent
  pending decisions, and safe compaction transfer.
- The standard action queue projects eligible Lead tasks. Existing approval
  admission remains unchanged; ordinary chat cannot settle a typed decision.
- A stage taken inside an automatic Lead tick records its exact response append
  boundary. Topic replay uses that durable link, preserves only that linked
  content from duplicate-progress suppression, and keeps chronological,
  single-copy history across predecessor lineage.

## Verification

- Break proof: removing the staged response index made
  `test/coop-owner-decision-history.test.js` fail 0/1; restoring it passed 1/1.
- Break proof: excluding the Lead project from the action queue made
  `test/global-coop-projection.test.js` fail 8/9; restoring it passed 9/9.
- Final focused suite passed 128/128. `npm test` passed 3,389 default tests and
  519 controlled-execution tests with `CLAY_COOP_CONTROL_STORE` intentionally
  unset for its default-off assertion.
