import { refreshIcons } from './icons.js';
import { showToast } from './utils.js';

var RESTART_ACK_TIMEOUT_MS = 8000;
var RESTART_FRESH_RUNTIME_TIMEOUT_MS = 30000;
var restartAckTimer = null;
var freshRuntimeTimer = null;

function restartButtonHtml() {
  return '<i data-lucide="refresh-cw" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px;"></i>Restart';
}

function getRestartButton() {
  return document.getElementById("settings-restart-btn");
}

function getRestartMessageEl() {
  return document.getElementById("settings-restart-error");
}

function clearRestartTimers() {
  if (restartAckTimer) {
    clearTimeout(restartAckTimer);
    restartAckTimer = null;
  }
  if (freshRuntimeTimer) {
    clearTimeout(freshRuntimeTimer);
    freshRuntimeTimer = null;
  }
}

function setRestartButtonReady() {
  var btn = getRestartButton();
  if (!btn) return;
  btn.disabled = false;
  btn.innerHTML = restartButtonHtml();
  refreshIcons();
}

function setRestartMessage(text, failed) {
  var errorEl = getRestartMessageEl();
  if (!errorEl) return;
  errorEl.textContent = text;
  errorEl.classList.remove("hidden");
  if (failed) {
    errorEl.classList.add("settings-restart-failed");
  } else {
    errorEl.classList.remove("settings-restart-failed");
  }
}

function hideRestartMessage() {
  var errorEl = getRestartMessageEl();
  if (!errorEl) return;
  errorEl.textContent = "";
  errorEl.classList.add("hidden");
  errorEl.classList.remove("settings-restart-failed");
}

function failRestart(message) {
  clearRestartTimers();
  setRestartButtonReady();
  setRestartMessage(message, true);
  showToast("Restart failed", "error", message);
}

function waitForRestartAck() {
  if (restartAckTimer) clearTimeout(restartAckTimer);
  restartAckTimer = setTimeout(function () {
    restartAckTimer = null;
    failRestart("Restart command was sent, but the daemon did not acknowledge it. Check the connection and try again.");
  }, RESTART_ACK_TIMEOUT_MS);
}

function waitForFreshRuntime() {
  if (freshRuntimeTimer) clearTimeout(freshRuntimeTimer);
  freshRuntimeTimer = setTimeout(function () {
    freshRuntimeTimer = null;
    failRestart("Restart command was accepted, but this browser did not reconnect to a fresh daemon. Check the daemon log or run the restart command from a terminal.");
  }, RESTART_FRESH_RUNTIME_TIMEOUT_MS);
}

export function initRestartControls(appCtx) {
  var restartBtn = getRestartButton();
  if (!restartBtn) return;
  restartBtn.addEventListener("click", function () {
    var ws = appCtx.ws;
    hideRestartMessage();
    if (!ws || ws.readyState !== 1) {
      failRestart("Cannot restart because this browser is not connected to the Clay daemon. Reconnect and try again.");
      return;
    }
    try {
      restartBtn.disabled = true;
      restartBtn.textContent = "Restarting...";
      ws.send(JSON.stringify({ type: "restart_server" }));
      waitForRestartAck();
    } catch (e) {
      failRestart("Failed to send restart command: " + (e && e.message ? e.message : e));
    }
  });
}

export function resetRestartButton() {
  clearRestartTimers();
  setRestartButtonReady();
  hideRestartMessage();
}

export function handleRestartResult(msg) {
  if (restartAckTimer) {
    clearTimeout(restartAckTimer);
    restartAckTimer = null;
  }

  var restartBtn = getRestartButton();
  if (!msg.ok) {
    failRestart(msg.error || "Restart failed");
    return;
  }

  if (msg.pending) {
    if (restartBtn) restartBtn.textContent = "Restart queued...";
    setRestartMessage("Restart queued until active provider tools finish.", false);
    showToast("Restart queued until active provider tools finish.", "info");
    return;
  }

  if (restartBtn) restartBtn.textContent = "Server restarting...";
  setRestartMessage("Restart command accepted. Waiting for this browser to reconnect to the new daemon.", false);
  showToast("Server is restarting...");
  waitForFreshRuntime();
}
