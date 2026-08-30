# R6 canonical worktree identity recovery

## Symptom

Temporary linked Git worktrees were registered by their filesystem paths as
separate configured projects. That gave their sessions a different ProjectRef,
produced an extra project-rail tile, and omitted live worktree activity from
the canonical Clay projection.

## Root cause

Project discovery treated a selected directory as a new durable project before
checking whether it belonged to an already configured Git worktree family.
The path can sit outside the parent checkout, so descendant-path checks cannot
establish canonical ownership.

## Recovery

`9903e84dd6` identifies a real Git worktree from the configured parent's
`git worktree list` data, registers it as a parent-owned runtime, gives it the
parent ProjectRef, and aggregates sibling runtime sessions for the Coop and
session-ledger projections. The client rail groups only canonical parents as
tiles. `d1b2969f1c` is the recoverable exact revert of the unrelated rejected
owner-ledger commit `52c892cba9862e49776f898d955795e9f748ab39`.

## Evidence

- Focused identity, reference, global projection, cross-project ledger, rail,
  and owner-sidebar suites: 92 passed, 0 failed.
- Reverting `9903e84dd6` without committing made a real Git-worktree identity
  check fail with `findRegisteredWorktree is not a function`; the revert was
  aborted and the candidate restored before the recovery commit was made.
- The live `daemon-dev.json` entry for
  `/private/tmp/clay-fix-r6-compaction-source-stream-fanout` is a linked
  worktree; the fixed resolver maps it to canonical Clay ProjectRef
  `5332aafc-31e7-5cb1-ba96-c8d90e78260e` instead of stale ProjectRef
  `e9afddc4-9943-5b8c-971c-2b267ed3b361`.

## Verification limits

The in-app browser had no available surface, so no owner-visible rail or Work
Ledger canary could be run. `npm test` also has two environment-only failures:
the workspace lacks `@anthropic-ai/claude-agent-sdk` and `@openai/codex` for
the YOKE adapter dependency checks. The recovery-specific tests passed.
