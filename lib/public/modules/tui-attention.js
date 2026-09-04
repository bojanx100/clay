// tui-attention.js
//
// Modal that mounts a transient xterm attached to a Claude TUI session's
// PTY when the user clicks a tui_attention notification. It's the side
// channel for "respond to claude without leaving my current view".
//
// Cross-project gotcha: the user's main WebSocket is bound to whatever
// project they're currently viewing, but the TUI session lives in a
// different project. Sending term_* messages on the main WS would land
// in the wrong project's terminal-manager (silent miss, or worse, hit a
// terminal with the same numeric id in the other project). So the modal
// opens its OWN parallel WS to the source project's endpoint and pumps
// term_attach / term_input / term_output through that connection only.
// The main WS is untouched.

import { getTerminalTheme } from './theme.js';
import { getTerminalFontFamily, getTerminalFontSize, onTerminalFontChange } from './terminal-prefs.js';
import { ensureTerminalAssets } from './external-assets.js';

// TUI attention modal xterm follows Clay's active theme via
// getTerminalTheme() and live-updates through setTuiAttentionTheme()
// which theme.js calls from applyTheme.

var modalEl = null;
var modalXterm = null;
var modalFitAddon = null;
var modalTerminalId = null;
var modalSourceSlug = null;
var modalWs = null;
var modalResizeObserver = null;
var modalKeyHandler = null;
var modalResizeDebounce = null;
var modalOpenGeneration = 0;
// Provider install/login terminals share this modal with live TUI sessions.
// Setup metadata lets exit handling refresh Clay's provider evidence without
// hard-coding a small vendor list in the client.
var modalSetupVendor = null;
var modalSetupAction = null;
var modalSetupDisplayName = null;
var modalSetupBuf = "";

function vendorDisplayName(vendor, displayName) {
  if (displayName) return displayName;
  if (vendor === "codex") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  return "Claude";
}

// Called when the login command in the modal terminal exits. Detects success
// from the captured output, then tells the server to invalidate its auth
// cache and rebuild adapters (refresh_vendors) so the freshly authenticated
// vendor is picked up without a manual daemon restart or "new session" dance.
function handleSetupExit(exitCode) {
  var vendorName = vendorDisplayName(modalSetupVendor, modalSetupDisplayName);
  var actionName = modalSetupAction === "install" ? "install" : "login";
  var outputSuccess = /successfully logged in|logged in using|login successful|installation complete|successfully installed/i.test(modalSetupBuf || "");
  var success = exitCode === 0 || (exitCode == null && outputSuccess);
  if (modalXterm) {
    try {
      if (success) {
        modalXterm.write("\r\n\x1b[92m[" + vendorName + " " + actionName + " complete \u2014 verifying with Clay\u2026]\x1b[0m\r\n");
      } else {
        modalXterm.write("\r\n\x1b[90m[" + vendorName + " " + actionName + " exited without confirmation]\x1b[0m\r\n");
      }
    } catch (e) {}
  }
  // Re-check only the provider the user just configured. The server invalidates
  // shared auth evidence as part of that refresh, without starting every CLI.
  if (modalWs && modalWs.readyState === 1) {
    try { modalWs.send(JSON.stringify({ type: "refresh_provider", vendor: modalSetupVendor })); } catch (e) {}
  }
  if (success) {
    setTimeout(function () { closeTuiModal(); }, 1800);
  }
}
// Debounced fit+redraw for the modal xterm. Same rationale as
// session-tui-view.js: collapses rapid resize events into a single
// SIGWINCH so claude can redraw cleanly without mid-resize corruption.
function scheduleModalResize() {
  if (modalTerminalId == null) return;
  if (modalResizeDebounce) clearTimeout(modalResizeDebounce);
  modalResizeDebounce = setTimeout(function () {
    modalResizeDebounce = null;
    fitModalXterm();
    if (modalXterm) {
      try { modalXterm.refresh(0, modalXterm.rows - 1); } catch (e) {}
    }
  }, 120);
}

// --- Modal ---

function teardownModalXterm() {
  if (modalResizeObserver) {
    try { modalResizeObserver.disconnect(); } catch (e) {}
    modalResizeObserver = null;
  }
  if (modalXterm) {
    try { modalXterm.dispose(); } catch (e) {}
    modalXterm = null;
  }
  modalFitAddon = null;
}

function modalSend(msg) {
  if (!modalWs || modalWs.readyState !== 1) return;
  try { modalWs.send(JSON.stringify(msg)); } catch (e) {}
}

function fitModalXterm() {
  if (!modalXterm || !modalFitAddon || !modalEl) return;
  try {
    modalFitAddon.fit();
    if (modalTerminalId != null) {
      modalSend({ type: "term_resize", id: modalTerminalId, cols: modalXterm.cols, rows: modalXterm.rows });
    }
  } catch (e) {}
}

function ensureModal() {
  if (modalEl) return modalEl;
  modalEl = document.createElement("div");
  modalEl.className = "tui-modal-backdrop hidden";
  modalEl.innerHTML = '' +
    '<div class="tui-modal" role="dialog" aria-modal="true">' +
      '<div class="tui-modal-header">' +
        '<div class="tui-modal-breadcrumb">' +
          '<span class="tui-modal-project-icon"></span>' +
          '<span class="tui-modal-project-name"></span>' +
          '<span class="tui-modal-sep">›</span>' +
          '<span class="tui-modal-session-name"></span>' +
        '</div>' +
        '<button type="button" class="tui-modal-close" aria-label="Close">×</button>' +
      '</div>' +
      '<div class="tui-modal-body"></div>' +
    '</div>';
  document.body.appendChild(modalEl);
  modalEl.querySelector(".tui-modal-close").addEventListener("click", closeTuiModal);
  // Click the backdrop (outside the modal box) to dismiss.
  modalEl.addEventListener("click", function (e) {
    if (e.target === modalEl) closeTuiModal();
  });
  return modalEl;
}

function setModalBreadcrumb(info) {
  if (!modalEl) return;
  info = info || {};
  var iconEl = modalEl.querySelector(".tui-modal-project-icon");
  var nameEl = modalEl.querySelector(".tui-modal-project-name");
  var sessionEl = modalEl.querySelector(".tui-modal-session-name");
  if (iconEl) {
    if (info.projectIcon) {
      iconEl.textContent = info.projectIcon;
      iconEl.style.display = "";
    } else {
      iconEl.textContent = "";
      iconEl.style.display = "none";
    }
  }
  if (nameEl) nameEl.textContent = info.projectName || info.sourceSlug || "";
  if (sessionEl) sessionEl.textContent = info.sessionTitle || "Claude session";
}

/**
 * Open the TUI session modal.
 *
 * info: { sessionTitle?, projectName?, projectIcon? }
 *   - projectName / projectIcon are looked up by the caller (notification
 *     center has the cached project list) and rendered as a breadcrumb in
 *     the modal header so the user can see which project's session this is.
 */
export function openTuiModal(terminalId, sourceSlug, info) {
  if (typeof terminalId !== "number") return;
  if (!sourceSlug) return;
  var generation = ++modalOpenGeneration;
  ensureTerminalAssets().then(function () {
    if (generation !== modalOpenGeneration) return;
    openTuiModalReady(terminalId, sourceSlug, info);
  }).catch(function (err) {
    console.error("[tui-modal] Failed to load terminal assets:", err);
  });
}

function openTuiModalReady(terminalId, sourceSlug, info) {
  // If a previous modal is open, tear it down (terminal id or project
  // could differ; either way we want a clean slate).
  if (modalTerminalId != null) closeTuiModal();

  ensureModal();
  modalTerminalId = terminalId;
  modalSourceSlug = sourceSlug;
  var infoObj = info || {};
  modalSetupVendor = infoObj.setupVendor || infoObj.loginVendor || null;
  modalSetupAction = infoObj.setupAction || (infoObj.loginVendor ? "login" : null);
  modalSetupDisplayName = infoObj.setupDisplayName || null;
  modalSetupBuf = "";
  setModalBreadcrumb({
    projectIcon: infoObj.projectIcon || null,
    projectName: infoObj.projectName || sourceSlug,
    sessionTitle: infoObj.sessionTitle || "Claude session",
    sourceSlug: sourceSlug,
  });
  modalEl.classList.remove("hidden");

  // Compact sizing for short, content-light terminals (e.g. the login
  // wizard) so the box hugs the content instead of leaving a tall empty
  // black area below it. Full-size for live TUI sessions that fill the screen.
  var boxEl = modalEl.querySelector(".tui-modal");
  if (boxEl) boxEl.classList.toggle("tui-modal-compact", !!infoObj.compact);

  var bodyEl = modalEl.querySelector(".tui-modal-body");
  bodyEl.innerHTML = "";
  modalXterm = new Terminal({
    cursorBlink: true,
    fontSize: getTerminalFontSize(),
    fontFamily: getTerminalFontFamily(),
    theme: getTerminalTheme(),
    scrollback: 5000,
  });
  if (typeof FitAddon !== "undefined") {
    modalFitAddon = new FitAddon.FitAddon();
    modalXterm.loadAddon(modalFitAddon);
  }
  if (typeof WebLinksAddon !== "undefined") {
    try { modalXterm.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch (e) {}
  }
  modalXterm.open(bodyEl);

  modalXterm.onData(function (data) {
    if (modalTerminalId == null) return;
    modalSend({ type: "term_input", id: modalTerminalId, data: data });
  });

  // Open a dedicated WS to the source project so term_* messages route
  // to the right terminal-manager regardless of which project the user
  // is currently viewing.
  var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  var wsUrl = protocol + "//" + window.location.host + "/p/" + sourceSlug + "/ws";
  try { modalWs = new WebSocket(wsUrl); } catch (e) { modalWs = null; }
  if (!modalWs) {
    if (modalXterm) {
      try { modalXterm.write("\r\n\x1b[91m[Failed to open WebSocket to " + sourceSlug + "]\x1b[0m\r\n"); } catch (e) {}
    }
    return;
  }
  modalWs.onopen = function () {
    modalSend({ type: "term_attach", id: terminalId });
    fitModalXterm();
  };
  modalWs.onmessage = function (e) {
    var msg = null;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (!msg || msg.id !== modalTerminalId) return;
    if (msg.type === "term_output" && modalXterm && msg.data) {
      if (modalSetupVendor) {
        modalSetupBuf += msg.data;
        if (modalSetupBuf.length > 8000) modalSetupBuf = modalSetupBuf.slice(-8000);
      }
      modalXterm.write(msg.data);
    } else if (msg.type === "term_resized" && modalXterm && msg.cols > 0 && msg.rows > 0) {
      try { modalXterm.resize(msg.cols, msg.rows); } catch (err) {}
    } else if (msg.type === "term_exited" && modalXterm) {
      if (modalSetupVendor) {
        handleSetupExit(msg.exitCode);
      } else {
        try { modalXterm.write("\r\n\x1b[90m[session exited]\x1b[0m\r\n"); } catch (err) {}
      }
    } else if (msg.type === "term_closed") {
      closeTuiModal();
    }
  };
  modalWs.onclose = function () {
    if (modalXterm) {
      try { modalXterm.write("\r\n\x1b[90m[connection closed]\x1b[0m\r\n"); } catch (e) {}
    }
  };

  // Initial fit (won't send resize until WS opens; onopen also calls fit).
  setTimeout(fitModalXterm, 50);
  try { modalXterm.focus(); } catch (e) {}

  if (!modalResizeObserver && typeof ResizeObserver !== "undefined") {
    modalResizeObserver = new ResizeObserver(function () { scheduleModalResize(); });
    modalResizeObserver.observe(bodyEl);
  }

  // Esc-to-close.
  modalKeyHandler = function (e) {
    if (e.key === "Escape" && !e.defaultPrevented) {
      closeTuiModal();
    }
  };
  document.addEventListener("keydown", modalKeyHandler);
}

export function closeTuiModal() {
  modalOpenGeneration++;
  if (!modalEl) return;
  if (modalTerminalId != null && modalWs && modalWs.readyState === 1) {
    try { modalWs.send(JSON.stringify({ type: "term_detach", id: modalTerminalId })); } catch (e) {}
  }
  if (modalWs) {
    try { modalWs.close(); } catch (e) {}
    modalWs = null;
  }
  modalTerminalId = null;
  modalSourceSlug = null;
  modalSetupVendor = null;
  modalSetupAction = null;
  modalSetupDisplayName = null;
  modalSetupBuf = "";
  teardownModalXterm();
  modalEl.classList.add("hidden");
  if (modalKeyHandler) {
    document.removeEventListener("keydown", modalKeyHandler);
    modalKeyHandler = null;
  }
}

export function isTuiModalOpen() {
  return modalTerminalId != null;
}

export function getTuiModalTerminalId() {
  return modalTerminalId;
}

// Legacy no-op shims: the modal now owns its own WS connection so the
// main-WS term_* dispatcher no longer needs to forward messages to it.
// Kept (returning false) so existing app-messages.js fall-through
// chains compile without changes during the transition.
export function tuiModalHandleTermOutput() { return false; }
export function tuiModalHandleTermResized() { return false; }
export function tuiModalHandleTermExited() { return false; }
export function tuiModalHandleTermClosed() { return false; }

// Live theme update for the attention modal. Called by theme.js when
// the user switches themes. Also retints the surrounding modal chrome
// so the frame doesn't stay black when a light theme is active.
export function setTuiAttentionTheme(xtermTheme) {
  if (modalXterm) {
    try { modalXterm.options.theme = xtermTheme; } catch (e) {}
  }
  if (modalEl && xtermTheme && xtermTheme.background) {
    var bodyEl = modalEl.querySelector(".tui-modal-body");
    if (bodyEl) bodyEl.style.background = xtermTheme.background;
    var frameEl = modalEl.querySelector(".tui-modal");
    if (frameEl) frameEl.style.background = xtermTheme.background;
  }
}

// Live font update for the attention modal. Refit after applying so
// cell metrics + PTY cols/rows stay in sync.
onTerminalFontChange(function (family, size) {
  if (!modalXterm) return;
  try {
    if (family) modalXterm.options.fontFamily = family;
    if (size) modalXterm.options.fontSize = size;
  } catch (e) {}
  scheduleModalResize();
});
