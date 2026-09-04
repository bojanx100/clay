# Mobile send button debug report

- **Symptom:** On mobile, the composer often showed the square Stop action when the user expected the send arrow.
- **Root cause:** The send-button renderer applied the desktop rule `processing + empty composer = Stop` to touch devices. The supplied screenshot was captured during a real processing interval; the session recorded its terminal `done` event about nine seconds later, so this was not stale processing state.
- **Fix:** Touch composers now keep the primary action in send mode. Stop dispatch is gated on the button actually being rendered in Stop mode, so tapping an empty mobile arrow is a no-op rather than a hidden stop action.
- **Evidence:** Canary logs showed no correlated recovery or event-loop issue. `node --test test/*.test.js` passed all 375 tests.
- **Regression test:** `test/mobile-send-button.test.js`
- **Related:** Desktop retains the existing Stop behavior while a response is active.
- **Status:** DONE_WITH_CONCERNS — automated browser verification was unavailable because no browser surface was connected; source-level behavior and the full automated suite passed.
