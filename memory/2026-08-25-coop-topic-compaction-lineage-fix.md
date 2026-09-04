# Coop topic lineage across compaction (2026-08-25)

## Symptom

After the canonical Coop/Lead conversation was compacted, topic behavior split:

- topic projection could drop predecessor-owned Threads entirely,
- selecting a predecessor-owned topic from the successor session could fail
  closed or replay the wrong history,
- reply anchors, promotion, queue authorization, and title/anchor retrofits
  still read refs as if every topic membership belonged to the successor's
  local history array.

Main had already been repaired to stay selectable across compaction, but the
topic stack still treated the compacted successor like a brand-new canonical
transcript instead of the same transcript's continuation.

## Root cause

Topic state is durable by `sessionStorageId` and many existing memberships still
point at the predecessor storage id after compaction. The runtime paths that
project, validate, replay, and derive topic state were still assuming:

- the canonical storage id must equal the current session's storage id, and
- every `eventIndex` can be read directly from the current session's raw
  `history` array.

That is false once a visible Coop successor carries `compactedFromStorageId`.
The durable topic refs were still correct; the read paths had become too narrow.

## Fix

- Added `lib/coop-topic-lineage.js` to build a replay session spanning the
  compacted predecessor chain and to resolve per-session event refs back to
  absolute replay indexes.
- Taught the topic index, replay, projection, anchor, reply-anchor, promotion,
  queue-authorization, and retrofit/title-refinement paths to read topic
  memberships through lineage-aware helpers instead of assuming one flat local
  history.
- Replayed compacted topic selection through the normal `switchSession` seam by
  letting `sessions-lifecycle.switchSession()` accept an optional replay source
  session while preserving the real session identity and `session_switched`
  side effects.
- Renamed the owner-facing panel copy from "Session context" / "Owner control"
  to "Workspace" / "Work tracker" in the same change set.

## Verification

- Break proof: temporarily restored the old strict canonical-storage-id check.
  `test/coop-topic-index.test.js` failed 1/22 and
  `test/project-connection-handlers.test.js` failed 1/16, exactly on the two
  new compacted-lineage regressions.
- Restored the lineage-aware check: both files passed 22/22 and 16/16.
- Focused cross-module suite passed 118/118:
  `test/coop-topic-index.test.js`
  `test/coop-topic-relevance.test.js`
  `test/coop-topic-disposition.test.js`
  `test/project-connection-handlers.test.js`
  `test/project-connection-state.test.js`
  `test/app-messages-coop-topics.test.js`
  `test/coop-owner-sidebar.test.js`
  `test/workspace-panel-design.test.js`
- Adjacent lifecycle/history checks passed 3/3:
  `test/sessions-lifecycle.test.js`
  `test/project-sessions-view.test.js`
- Post-rebase history coverage passed 13/13:
  `test/session-history.test.js`
  `test/sessions-lifecycle.test.js`
  `test/project-sessions-view.test.js`
