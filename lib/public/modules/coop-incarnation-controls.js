import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { showConfirm } from './confirm-modal.js';
import { showToast } from './utils.js';

var pendingRequestId = "";

function isCoop() {
  return store.get('currentSlug') === 'lead';
}

function requestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'coop-incarnation-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function sendRestart() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) {
    showToast('Coop is not connected', 'warn');
    return;
  }
  pendingRequestId = requestId();
  ws.send(JSON.stringify({
    type: 'coop_incarnation_restart',
    requestId: pendingRequestId,
  }));
}

function refresh() {
  var restart = document.getElementById('config-coop-restart-btn');
  var modelLabel = document.getElementById('config-model-section-label');
  if (restart) restart.classList.toggle('hidden', !isCoop());
  if (modelLabel) modelLabel.textContent = isCoop() ? 'SWITCH MODEL' : 'SESSION MODEL';
}

export function initCoopIncarnationControls() {
  var restart = document.getElementById('config-coop-restart-btn');
  if (restart) {
    restart.addEventListener('click', function () {
      var popover = document.getElementById('config-popover');
      if (popover) popover.classList.add('hidden');
      showConfirm(
        'Restart Coop\'s model context? Its conversation, Threads, backlog, and outstanding work will stay in place.',
        sendRestart,
        'Restart Coop',
        false
      );
    });
  }
  refresh();
  store.subscribe(function (state, previous) {
    if (state.currentSlug !== previous.currentSlug) refresh();
  });
}

export function handleCoopIncarnationResult(message) {
  if (!message || message.type !== 'coop_incarnation_result') return false;
  if (pendingRequestId && message.requestId && message.requestId !== pendingRequestId) return true;
  pendingRequestId = '';
  if (message.ok) {
    var label = message.action === 'restart' ? 'Coop restarted with a fresh model context' :
      (message.action === 'model' ? 'Coop switched model with a fresh context' :
        'Coop switched provider with a fresh context');
    showToast(label, 'info');
  } else {
    showToast(message.message || 'Coop could not change model context', 'warn');
  }
  return true;
}
