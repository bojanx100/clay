# Coop Voice

Owner contract, clarified 2026-09-06: Voice should support an ongoing conversation without relying on a keyboard. Lead on means talking with Coop only. Lead off means talking with the selected individual session.

## Implemented on coop_v2

- Opening Voice with Lead on opens canonical Coop if necessary, then starts listening. Main, All, project and topic views remain lenses of that conversation; Voice creates no special topic or session.
- With Lead off, ordinary GUI sessions expose Voice and retain their selected provider. Retained Coop history, Coop channels, DMs and terminal-only sessions do not become voice destinations.
- Speech sends automatically after an 800 ms pause. A recording captures its project, session and Coop lens before requesting microphone permission. Changing project, session or Lead mode ends the voice conversation; switching Coop lenses does not redirect an utterance already being recorded.
- Voice sends through the ordinary authenticated message/queue protocol. It preserves a typed draft and staged attachments, and only reports transport acceptance when the socket accepts the frame. This is not a provider-completion or durable-delivery receipt.
- `user_turn_started` identifies actual SDK dispatch by client message ID. Queued speech ignores the preceding task's output, unrelated session output and replayed history. Unsent speech can wait through a connection interruption; already-submitted speech is not automatically resent.
- Spoken replies are sanitized and split into short browser utterances, without the former 640-character cutoff. Listening resumes after playback. Recognition callbacks from an old microphone and late permission results cannot resurrect stopped listening.
- “End voice conversation” ends audio without stopping project work. Stop speech/Listen can interrupt playback manually.
- Voice discovers live pending Claude questions and Codex `request_user_input` questions when it opens and as requests change. It reads questions and options, accepts option numbers or labels, supports multiple selections where allowed, and preserves free-text answers where the provider permits them. It reads back the complete answer set before “submit answers.” “Change answers,” “repeat question” and “retry questions” work by voice.
- A voice answer names the exact session, request and question revision. Replaced, edited, already answered and cancelled requests reject stale answers without falling back to a new chat message. A newly spoken prompt discards speech captured before it appeared. Reconnect checks whether a submitted question is still waiting; it never automatically resubmits the answer.
- Claude stateless question answers use the ordinary owner-message queue with voice turn identity and the captured Coop lens. Blocking native Claude questions and Codex questions resolve their existing provider callback. Codex replies use its question-ID-to-answer-array protocol; ordinary MCP forms retain their different response format. This also corrects on-screen Codex question answers.


Composer dictation remains a separate input feature. The Voice button starts a conversation; dictation prepares a draft.

## Remaining work for a fully hands-free product

The current implementation uses half-duplex browser speech: recognition pauses while Clay speaks to avoid hearing its own reply as an instruction. Spoken interruption during playback needs an audio adapter with reliable echo handling and voice activity detection. Clicking Listen is still required for immediate interruption.

~~Structured question, permission, plan-review and form dialogs still use their existing interfaces. Voice needs exact pending-request resolution and spoken option/answer handling.~~ Retracted in part, 2026-09-06: ordinary Claude and Codex questions now have the spoken flow above. Permission approvals, secret questions, arbitrary forms and plan-review dialogs still require their existing interfaces. Voice announces these unsupported pending dialogs and does not treat a spoken “yes” as permission. The full set of decision flows is not hands-free yet.

The question snapshot describes live provider callbacks and stateless pending questions, not historical cards. It does not recreate provider requests after a daemon restart or provider handoff. A consumed question is not proof that the subsequent provider turn finished; reply replay across disconnection remains separate work.

Reconnect playback is not a durable audio session: historical replies are not automatically read back, and completion while disconnected still needs reconciliation with the exact pending voice turn. Refreshing the page loses ephemeral microphone state. Mobile audio, background listening, cross-device handoff and interruption need separate device validation.

No paid voice service or alternative reasoning model was introduced. These changes use the selected Clay session's provider and the browser's existing speech interfaces. Actual microphone permission, speech recognition accuracy, audible playback and provider latency were not tested in this change.

## Verification

### Spoken question follow-up, 2026-09-06

The full suite passed **4,554 normal tests across 467 files and 849 controlled-mode tests across 70 files**. After that run, the guard against speech captured before a new question was added; the final focused suite passed **40/40 tests across seven files**. Tests drive live pending-state lookup, the real permission/dialog handlers, the real Codex adapter event handler with an in-process app-server fixture, and scripted recognition/playback through the conversation controller. They do not exercise actual microphones, external provider inference or audible browser playback.

Codex response fields were checked against JSON schemas generated by the installed `codex app-server generate-json-schema` command, including `ToolRequestUserInputResponse.json`. No paid service or live model call was needed.

| Removed follow-up fix | Passing | Failing |
| --- | ---: | ---: |
| Codex question adapter restored to its previous source | 1 | 4 |
| Exact question revision comparison removed | 6 | 1 |
| Controller question integration restored to its previous source | 6 | 1 |
| Cancelled-dialog resolution event removed | 6 | 1 |
| Lost answer acknowledgement reconciliation removed | 6 | 1 |
| Claude voice answer bypasses the ordinary owner queue | 6 | 1 |
| New prompt retains earlier captured speech | 11 | 1 |
| All follow-up fixes restored | 40 | 0 |

The subsequent merge of bojan `c48562a295` brought in revalidated auto-launch adoption and exact completed-work reconsideration. The merge was clean and retained v2 coordinator-resolution behavior. Related tests passed: **194 normal tests across nine files and 52 controlled-mode tests across three files**, including commit-message checks.

### Earlier conversation routing work

The full suite passed with 4,534 normal tests across 464 files and 849 controlled-mode tests across 70 files. A subsequent provider-selection field and defensive Coop-navigation check passed the final focused suite: **20/20 tests across four files**. The DOM fixture drives the real Voice UI with scripted browser interfaces, and dispatch tests exercise both the ordinary queue and the separate Coop ingress queue; these are not live audio measurements.

The production changes were removed temporarily, tests were run, then the changes were restored:

| Removed change | Passing | Failing |
| --- | ---: | ---: |
| Controller restored to its pre-fix source | 1 | 10 |
| Actual turn-dispatch event restored to its pre-fix source | 0 | 1 |
| Voice UI restored to its pre-fix source | 1 | 2 |
| Lead-mode destination rule reverted to Coop-only routing | 2 | 3 |
| Current destination guard removed | 4 | 1 |
| Actual socket-send result ignored | 4 | 1 |
| All fixes restored, final focused suite | 20 | 0 |

Latest bojan bookkeeping repairs (`5d867d7c51`) were merged into this branch. The conflict resolution preserves both its rearmable/unrouted binding behavior and v2's requirement for fresh primitive eligibility before reopening completed work. Relevant merge tests passed: 108 normal and 60 controlled tests.

Neither running daemon was restarted for this work. Activation must load the updated backend as well as the browser modules: reply attribution depends on the new dispatch event. A browser refresh against the old backend alone is insufficient.
