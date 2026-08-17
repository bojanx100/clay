# Sticky notes as agent-controllable long-term memory

**Goal (Chad, 2026-08-17):** sessions can read and write the project's
sticky notes, turning the existing shared canvas into visible long-term
memory. The user always sees what the agent remembers, can edit or
delete it, and every vendor gets the same memory because injection is
plain text.

## Why sticky notes beat a hidden memory file

- Visible: memory lives on a canvas the user already watches; an agent
  writing a note is immediately observable (nm broadcasts keep every
  client live).
- Editable: the user can correct or delete a wrong memory directly, no
  tooling needed.
- Cross-vendor: injection is text, so claude/codex/kiro all share the
  same memory without vendor work.
- Fable-class models measurably improve with a memory surface they are
  told to consult and maintain.

## Existing plumbing (verified 2026-08-17)

- `lib/notes.js` createNotesManager: `list/create/update/remove/
  bringToFront/getActiveNotesText`, per-project persistence, broadcast
  on every mutation. Wired in project.js:810 (`nm`).
- Client canvas: `lib/public/modules/sticky-notes.js` (recently
  stabilized, split view shares one canvas above both panes).
- A knowledge sync of `getActiveNotesText()` already exists for mate
  contexts (project.js:1725-1737).
- Session-bound MCP mounting pattern: project-session-spawn/pair.

## Design

### 1. MCP tools (`clay-notes`, mounted on project sessions)

- `list_notes` -> `[{id, text, color, updatedAt, origin}]`. Auto-allowed
  (read-only).
- `write_note` -> `{id?, text, color?}`; no id creates, id updates.
  Auto-allowed: the write is immediately visible on the shared canvas,
  which IS the oversight. Agent-created notes get
  `origin: {sessionId, vendor}` and auto-placement (cascade offset from
  the last note; never on top of an existing one).
- `remove_note` -> `{id}`. Auto-allowed ONLY for notes whose origin is
  the calling session; removing a user-created note (or another
  session's) keeps the permission prompt -- deleting someone else's
  memory is destructive.
- Tool descriptions frame the memory contract AND the register (Chad,
  2026-08-17: notes must never get verbose -- they are sticky notes):
  "Shared project memory on the user's board. One note = one fact,
  decision, or reminder, written like a real sticky note: a phrase or
  at most two short sentences. Never paragraphs, lists of steps, or
  logs. Update an existing note instead of adding a near-duplicate;
  delete notes that stop being true."

### 2. Injection (the recall half)

- On every query start, inject active notes as a bounded context block
  via the existing vendor-neutral instruction path (same family as
  instructions.scanAndMerge / appendSystemPrompt from a726fbc):
  `"--- Project sticky notes (shared memory; manage via clay-notes
  tools) ---"` + `getActiveNotesText()`.
- Caps: 2000 chars total, newest-first truncation with a note telling
  the model to use list_notes for the rest. Zero notes -> inject
  nothing. The injection block is intentionally small: sticky notes are
  an index of durable facts, not a context dump.
- This makes recall automatic; the agent does not need to remember to
  look.

### 3. UI (small)

- Agent-created notes render a small vendor avatar badge (origin) in
  the note corner, mirroring the delegated-message pattern.
- No other canvas changes; the whole point is reusing the existing
  surface.

## Rails

- REVISED (Chad, 2026-08-17): no short hard cap -- the canvas has a
  collapse affordance, so long notes are fine on the BOARD. The real
  enemy is rambling register, which the tool description polices, not
  a length rejection. Keep only a generous abuse guard: write_note
  rejects past 2000 chars.
- Context cost is contained at INJECTION instead: each note contributes
  at most ~240 chars (preview + "... (list_notes for the full note)"),
  total block still capped at 2000 chars.
- Note count cap (20 active) -- write_note errors past it, prompting
  consolidation/cleanup instead of unbounded growth.
- remove_note ownership rule above.
- Injection is capped and clearly labeled so prompts stay auditable.

## Proactive use (Chad, 2026-08-17: "적극적으로, 하지만 남용 없이")

The goal is that users NOTICE the board being useful without being
spammed by it.

- Inject the policy block on EVERY query, even with zero notes (an
  empty board must still announce the capability, otherwise the agent
  never volunteers). Zero-note form: label + "(board is empty)" +
  policy text.
- Policy text (goes inside the injected block, terse):
  "Use the board proactively: when the user states a decision,
  preference, correction, or durable project fact that future sessions
  will need, record it with write_note WITHOUT being asked, and say so
  in one short clause. The bar: a person skimming the board a week
  from now must still find the note useful, and it must stand on its
  own without this conversation. Never write announcement or narration
  notes ('leaving a note', 'did X just now'), routine progress,
  transient state, or anything the repo already records. Update or
  remove your stale notes instead of adding near-duplicates. A task
  should rarely add more than one or two notes."
  (Revised 2026-08-17 per Chad: notes must be human-valuable memory,
  never self-narration; writes run with no permission prompt.)
- Noticeability: on an agent write, the server broadcasts
  `note_written {id, byTitle, vendor, preview}` (register in
  ws-schema); non-pane clients toast "<title> left a note: <preview>"
  and pulse the note on the canvas. User's own edits never toast.
- Abuse ceiling stays structural: 20 active notes, 2000-char guard,
  ownership rule.

## Out of scope (v1)

- Per-note "include in context" toggles (all active notes inject, cap
  applies).
- Cross-project notes.
- Mate sessions (isMate skips the server, same as clay-sessions).

## Tests

- notes tool handlers against a stubbed nm: create/update/remove,
  ownership rule on remove, size/count caps.
- Injection: cap truncation, empty-notes no-op, label format.

## Acceptance (live, daemon restart)

1. Ask a session to "remember X on the board" -> note appears on the
   canvas with the session's vendor badge, no permission prompt.
2. New session (any vendor) asked "what do you remember?" answers from
   the injected notes without calling tools.
3. Agent updates its own note without a prompt; asking it to delete a
   user-created note triggers the permission prompt.
4. Notes survive daemon restart (existing nm persistence).
