# Claude Many-Image Dimension Rejection

## Status

Implemented and verified locally on 2026-08-30.

## Symptom and confirmed cause

Claude rejected a follow-up with:

`messages.48.content.1.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels`

The affected native Claude transcript contained 25 base64 image blocks. Six
older screenshots had an edge over 2000 pixels, including 2557x961, 2554x970,
2309x959, 2306x459, 2303x439, and 2277x941. The current upload was only 214x65.
Anthropic applies the stricter 2000-pixel per-image limit once a request has
more than 20 image or document blocks.

Clay's composer checked only the decoded byte estimate before accepting an
image. A highly compressed screenshot could therefore be far below the 5 MB
byte threshold while exceeding the provider's dimension limit. The Claude
adapter then embedded that base64 payload without inspecting its dimensions.

## Repair

- Decode every pasted or selected browser image before attachment.
- Create a provider-safe copy with a maximum edge of 1920 pixels while
  preserving the original attachment for Clay history and file access.
- Preserve the existing lossy JPEG path for images over 5 MB.
- Verify PNG, JPEG, GIF, and WebP dimensions again at the Claude adapter
  boundary. An unsafe or unverifiable image becomes a precise text fallback
  with its preserved file path instead of an invalid Claude image block.
- Apply the guard to both in-process and worker-backed Claude query handles.
- Recognize Claude's zero-cost synthetic image-history rejection and move an
  eligible conversation into one fresh compacted continuation. Existing
  coordinator/control-plane refusal checks remain in force, so recovery cannot
  orphan active worker ownership.

## Verification

- Expanded project isolated runner: 71 tests passed, 0 failed across the seven
  most relevant image, Claude, message-processing, compaction, lifecycle, and
  adapter files. An earlier broad related run also passed 49 of 49 tests across
  nine Claude, message-preparation, queue, and adapter files.
- Wider processor/compaction regression run: 255 tests passed, 0 failed across
  17 default-pass files, followed by 12 tests passed, 0 failed in the
  controlled-execution pass.
- New regression set: 8 passed, 0 failed.
- Negative control, restored afterward: replacing both dimension caps with
  `Infinity` made 4 tests pass and 4 fail; restoring the caps returned the set
  to 8 pass and 0 fail.
- Recovery negative control, restored afterward: disabling the native-error
  classifier made 43 tests pass and 2 fail; restoring it returned the set to
  45 pass and 0 fail.
- The regression drives the observed 2557x961/99,225-byte predicate and a
  26-image Claude payload. Every emitted direct image is measured at or below
  2000 pixels, and an oversized 2309-pixel image is omitted with a preserved
  path warning.
- The original image is saved to disk while the normalized provider copy
  reaches the real Claude message queue.
- The Claude image-boundary helper has 89.65% statement coverage and 100%
  function coverage in the focused coverage run.
- Client import resolution passed for all 194 client modules. The changed
  helper files passed the repository complexity lint configuration.

The full `npm test` run reached 345 of 347 default-pass files with no failures,
then was stopped because the unrelated `coop-control-sdk-fence.test.js`
worker-exit loop did not terminate. A separate pre-existing worktree run was
already stuck on the same test. The controlled-execution pass therefore did
not run, and this partial full-suite result is not claimed as a complete green
gate.

## Operational limitation

This repair prevents new oversized images from entering Claude's native
history and automatically starts a safe compacted continuation when Claude
reports that an existing native history is already polluted. It deliberately
does not rewrite provider-owned transcript files. No live daemon was restarted
and no live Anthropic request was made from this worktree.
