import { handleLiveUiState, handleLiveUiSelection } from './live-ui.js';
import { sendLiveUiServerEnvelope } from './app-misc.js';
import { forwardLiveUiPickerState } from './live-ui-extension-picker.js';

export function handleLiveUiMessage(msg) {
  if (msg.type === "live_ui_state") {
    forwardLiveUiPickerState(msg);
    handleLiveUiState(msg);
    if (msg.pairingId) sendLiveUiServerEnvelope(msg);
    return true;
  }
  if (msg.type === "live_ui_selection") {
    handleLiveUiSelection(msg);
    return true;
  }
  if (msg.type === "live_ui_relay") {
    sendLiveUiServerEnvelope(msg);
    return true;
  }
  return false;
}
