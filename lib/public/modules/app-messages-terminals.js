import { store } from './store.js';
import { handleTermList, handleTermCreated, sendTerminalCommand, handleTermOutput, handleTermResized, handleTermExited, handleTermClosed } from './terminal.js';
import { updateTerminalList } from './context-sources.js';
import { tuiHandleTermOutput, tuiHandleTermResized, tuiHandleTermExited, tuiHandleTermClosed } from './session-tui-view.js';
import { tuiModalHandleTermOutput, tuiModalHandleTermResized, tuiModalHandleTermExited, tuiModalHandleTermClosed, openTuiModal } from './tui-attention.js';

export function handleTerminalMessage(msg) {
  switch (msg.type) {
    case "term_list":
      var activeSessionId = store.get("activeSessionId");
      var scopedTerminals = (msg.terminals || []).filter(function (terminal) {
        return terminal && terminal.sessionId === activeSessionId;
      });
      handleTermList({ terminals: scopedTerminals });
      updateTerminalList(scopedTerminals.filter(function (terminal) {
        return terminal.kind !== "tui-session";
      }));
      return true;

    case "term_created":
      if (store.get('pendingLoginModal')) {
        var _lm = store.get('pendingLoginModal');
        store.set({ pendingLoginModal: null });
        openTuiModal(msg.id, _lm.slug, {
          sessionTitle: (_lm.vendor === "codex" ? "Codex" : "Claude") + " login",
          projectName: _lm.slug,
          compact: true,
          loginVendor: _lm.vendor || "claude",
        });
        return true;
      }
      handleTermCreated(msg);
      if (store.get('pendingTermCommand')) {
        var cmd = store.get('pendingTermCommand');
        store.set({ pendingTermCommand: null });
        setTimeout(function() {
          sendTerminalCommand(cmd);
        }, 300);
      }
      return true;

    case "term_output":
      if (!tuiModalHandleTermOutput(msg) && !tuiHandleTermOutput(msg)) handleTermOutput(msg);
      return true;

    case "term_resized":
      if (!tuiModalHandleTermResized(msg) && !tuiHandleTermResized(msg)) handleTermResized(msg);
      return true;

    case "term_exited":
      if (!tuiModalHandleTermExited(msg) && !tuiHandleTermExited(msg)) handleTermExited(msg);
      return true;

    case "term_closed":
      if (!tuiModalHandleTermClosed(msg) && !tuiHandleTermClosed(msg)) handleTermClosed(msg);
      return true;

    default:
      return false;
  }
}
