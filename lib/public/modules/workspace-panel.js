// Session Context ("Workspace") panel — client side.
//
// A slide-in side panel (same pattern as the Terminal / File Viewer panels)
// that surfaces, for the active session: linked GitHub issues/PRs with their
// media, the project board + PR + preview links, the worktree/branch, all
// session-attached screenshots, and a Start/Stop dev-server control.
//
// State/deps follow CLIENT_MODULE_DEPS.md: store.js + ws-ref.js + direct
// imports, no _ctx bag.

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { mergeWorkspaceState } from './workspace-panel-state.js';
import { escapeHtml, showToast } from './utils.js';
import { showMediaModal } from './app-misc.js';
import { refreshIcons } from './icons.js';
import { addPendingImageFromUrl } from './input.js';
import { closeTerminal } from './terminal.js';
import { closeFileViewer } from './filebrowser.js';
import { closeSidebar } from './sidebar.js';
import { getCachedSessions } from './sidebar-sessions.js';
import { wireLiveUiControls } from './live-ui.js';
import {
  devSectionHtml,
  linkedItemsHtml,
  sessionMediaHtml,
  workspaceSummaryHtml,
} from './workspace-panel-sections.js';
import { hasCoopOwnerContext, shouldDefaultOpenCoopOwnerLedger, renderWorkspaceCoopOwner } from './workspace-coop-owner.js';

var isOpen = false;
var subscribed = false;
// Default-open is a first-arrival behavior, not a forced panel. Once the owner
// closes the ledger in this browser session, live projection refreshes leave it
// closed until they choose to reopen it.
var defaultCoopLedgerOpened = false;
var devPollTimer = null;          // periodic dev-server status poll (panel open)
var DEV_POLL_MS = 5000;

// Per-session cache. The transcript can only grow, so we load a session's
// context once and reuse it on every revisit (no "Loading" flicker, no
// refetch). We re-fetch only when the session has moved forward — when its
// lastActivity advances or a turn completes while the panel is open.
var stateBySession = {};   // sessionId -> { state, activity }
var requestedFor = null;   // sessionId of the in-flight workspace_get

var refreshTimer = null;          // safety timeout to clear a stuck spinner

function panelEl() { return document.getElementById("workspace-panel"); }
function bodyEl() { return document.getElementById("workspace-body"); }

// Toggle the spinning state on the Refresh button. Cleared when the full
// (non-partial) state arrives, on error, or by a safety timeout.
function setRefreshing(on) {
  var btn = document.getElementById("workspace-refresh-btn");
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  if (!btn) return;
  if (on) {
    btn.classList.add("ws-refreshing");
    refreshTimer = setTimeout(function () { setRefreshing(false); }, 10000);
  } else {
    btn.classList.remove("ws-refreshing");
  }
}

function curSession() { return store.get('activeSessionId'); }

function activityOf(id) {
  if (id == null) return 0;
  var list = getCachedSessions() || [];
  for (var i = 0; i < list.length; i++) {
    if (String(list[i].id) === String(id)) return list[i].lastActivity || 0;
  }
  return 0;
}

function sendWs(obj) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function renderCoopOwnerControl() {
  if (!hasCoopOwnerContext(getCachedSessions())) return false;
  var rendered = renderWorkspaceCoopOwner(bodyEl(), {
    send: sendWs,
    onNavigate: closeWorkspacePanel,
  });
  if (rendered) setRefreshing(false);
  return rendered;
}

function openDefaultCoopLedger() {
  if (defaultCoopLedgerOpened || isOpen || !shouldDefaultOpenCoopOwnerLedger(getCachedSessions())) return false;
  defaultCoopLedgerOpened = true;
  openWorkspacePanel();
  return true;
}

// Fire a workspace_get for the active session. Never shows "Loading" itself —
// the caller decides whether to show a placeholder first.
function requestState() {
  if (!store.get('connected')) return;
  requestedFor = curSession();
  sendWs({ type: "workspace_get", sessionId: requestedFor });
}

// Poll the dev-server status while the panel is open. This is a lightweight
// message (just a port probe server-side) so the panel notices servers that
// were started or stopped outside Clay, instead of showing a stale status.
function pollDevStatus() {
  if (!isOpen || !store.get('connected')) return;
  sendWs({ type: "workspace_dev_status_get", sessionId: curSession() });
}

function startDevPoll() {
  if (devPollTimer) return;
  devPollTimer = setInterval(pollDevStatus, DEV_POLL_MS);
}

function stopDevPoll() {
  if (!devPollTimer) return;
  clearInterval(devPollTimer);
  devPollTimer = null;
}

// Render the active session: cached content instantly, fetching only when we
// have no cache or the session advanced. `force` always refetches (Refresh).
function showForActive(force) {
  if (renderCoopOwnerControl()) return;
  var id = curSession();
  var cached = stateBySession[id];
  if (cached) {
    // Render whatever we have instantly. A cached skeleton (partial) still
    // needs the GitHub half, so always finish loading it; a full cache only
    // refetches when forced or the session advanced.
    render(cached.state);
    if (cached.state.partial || force || activityOf(id) > cached.activity) requestState();
  } else {
    renderLoading();
    requestState();
  }
}

export function initWorkspacePanel() {
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.addEventListener("click", toggleWorkspacePanel);

  var closeBtn = document.getElementById("workspace-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closeWorkspacePanel);

  var refreshBtn = document.getElementById("workspace-refresh-btn");
  if (refreshBtn) refreshBtn.addEventListener("click", function () {
    if (!store.get('connected')) { showToast("Not connected", "error"); return; }
    setRefreshing(true);
    showForActive(true);
  });

  if (!subscribed) {
    subscribed = true;
    store.subscribe(function (state, prev) {
      if (!isOpen && (state.activeSessionId !== prev.activeSessionId ||
          state.coopProjectionVersion !== prev.coopProjectionVersion)) openDefaultCoopLedger();
      if (!isOpen) return;
      // Switched sessions: show that session's cache (fetch once if unseen).
      if (state.activeSessionId !== prev.activeSessionId) { showForActive(false); return; }
      if (state.coopProjectionVersion !== prev.coopProjectionVersion && renderCoopOwnerControl()) return;
      if (state.coopOwnerLedgerDetails !== prev.coopOwnerLedgerDetails && renderCoopOwnerControl()) return;
      // A turn just completed in this session: chat moved forward, so pull the
      // delta (new issue refs / media). Silent — keep current content shown.
      if (prev.processing && !state.processing) requestState();
    });
  }
  openDefaultCoopLedger();
}

export function toggleWorkspacePanel() {
  if (isOpen) closeWorkspacePanel();
  else openWorkspacePanel();
}

export function openWorkspacePanel() {
  var el = panelEl();
  if (!el) return;
  // Mutually exclusive with the other right-hand panels.
  closeFileViewer();
  closeTerminal();
  el.classList.remove("hidden");
  isOpen = true;
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.classList.add("active");
  if (window.innerWidth <= 768) closeSidebar();
  showForActive(false);
  startDevPoll();
  refreshIcons();
}

export function closeWorkspacePanel() {
  var el = panelEl();
  if (!el) return;
  el.classList.remove("panel-fullscreen");
  el.classList.add("hidden");
  isOpen = false;
  stopDevPoll();
  var btn = document.getElementById("workspace-toggle-btn");
  if (btn) btn.classList.remove("active");
}

// --- Message handlers (routed from app-messages.js) ---------------------

export function handleWorkspaceState(msg) {
  var id = (msg.sessionId != null) ? msg.sessionId : requestedFor;
  if (msg.error) {
    setRefreshing(false);
    if (isOpen && String(id) === String(curSession())) renderError(msg.error);
    return;
  }
  var cached = stateBySession[id];
  // A refetch's skeleton must not wipe the GitHub half we already loaded.
  var next = mergeWorkspaceState(cached && cached.state, msg);
  stateBySession[id] = { state: next, activity: activityOf(id) };
  // Stop the spinner once the full (non-partial) state for this session lands.
  if (!msg.partial && String(id) === String(curSession())) setRefreshing(false);
  if (isOpen && String(id) === String(curSession())) render(next);
}

// Live context patch pushed by the server when the agent switches the worktree
// it's editing in (mid-turn). Merge branch/worktree/dev into the matching
// session's cached state — keeping the already-loaded GitHub items — and
// re-render if that session's panel is open, so it tracks the agent live.
export function handleWorkspaceContext(msg) {
  var id = (msg.sessionId != null) ? msg.sessionId : curSession();
  var cached = stateBySession[id];
  if (!cached || !cached.state) return; // no skeleton yet; panel fetches on open
  var s = cached.state;
  if (msg.branch !== undefined) s.branch = msg.branch;
  if (msg.worktree !== undefined) s.worktree = msg.worktree;
  if (msg.dev !== undefined) s.dev = msg.dev;
  if (isOpen && String(id) === String(curSession())) render(s);
}

export function handleWorkspaceDevStatus(msg) {
  // The dev server is per-project; reflect it in the active session's cache.
  var id = curSession();
  var cached = stateBySession[id];
  if (cached && cached.state && cached.state.dev) {
    var dev = cached.state.dev;
    dev.running = msg.running;
    dev.portLive = msg.portLive;
    dev.external = msg.external;
    dev.status = msg.status || (msg.running ? (msg.portLive ? "running" : "starting") : "stopped");
    if (msg.branch !== undefined) dev.branch = msg.branch;
    if (msg.port) {
      dev.port = msg.port;
      dev.localUrl = msg.localUrl || "http://localhost:" + msg.port;
    }
    dev.tailscaleUrl = msg.tailscaleUrl || null;
    dev.terminalId = msg.terminalId;
  }
  if (isOpen) {
    // Update only the dev section so we don't disturb the rest of the panel
    // (e.g. the "Add issue" input). Fall back to a full/dev-only render if the
    // section isn't on the page yet.
    if (cached && cached.state) {
      if (!updateDevSection(cached.state)) render(cached.state);
    } else {
      renderDevOnly(msg);
    }
  }
}

// --- Rendering ----------------------------------------------------------

function renderLoading() {
  var b = bodyEl();
  if (b) b.innerHTML = '<div class="ws-empty">Loading workspace…</div>';
}

function renderError(text) {
  var b = bodyEl();
  if (b) b.innerHTML = '<div class="ws-empty ws-error">' + escapeHtml(text) + '</div>';
}

function renderDevOnly(msg) {
  var b = bodyEl();
  if (!b) return;
  var status = msg.status || (msg.running ? "running" : "stopped");
  var dev = msg.script
    ? {
      status: status,
      port: msg.port,
      external: msg.external,
      localUrl: msg.localUrl || (msg.port ? "http://localhost:" + msg.port : null),
      tailscaleUrl: msg.tailscaleUrl || null,
      script: msg.script,
      command: msg.command,
    }
    : null;
  b.innerHTML = devSectionHtml({ dev: dev });
  wireDevButton(b);
  refreshIcons();
}

// Copy an image URL to the clipboard as PNG (the only format browsers accept
// for image clipboard writes), converting via canvas when needed.
function copyImageToClipboard(url) {
  if (!navigator.clipboard || !window.ClipboardItem) { showToast("Clipboard not supported in this browser", "error"); return; }
  fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); })
    .then(function (blob) { return blob.type === "image/png" ? blob : blobToPng(blob); })
    .then(function (png) { return navigator.clipboard.write([new window.ClipboardItem({ "image/png": png })]); })
    .then(function () { showToast("Screenshot copied", "success"); })
    .catch(function (e) { showToast("Copy failed: " + (e && e.message || e), "error"); });
}

function blobToPng(blob) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var u = URL.createObjectURL(blob);
    img.onload = function () {
      var c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(u);
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error("encode failed")); }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(u); reject(new Error("image load failed")); };
    img.src = u;
  });
}

// Wire the start/stop button inside a dev-section container.
function wireDevButton(scope) {
  var devBtns = scope.querySelectorAll(".ws-devbtn[data-dev]");
  for (var i = 0; i < devBtns.length; i++) {
    devBtns[i].addEventListener("click", function () {
      var action = this.getAttribute("data-dev");
      var type = action === "start" ? "workspace_dev_start"
        : action === "restart" ? "workspace_dev_restart"
        : "workspace_dev_stop";
      sendWs({ type: type, source: "workspace-dev-control" });
      this.disabled = true;
    });
  }
}

// Replace just the dev section in place (used by the poll/status updates) so we
// don't blow away the rest of the panel — notably the "Add issue" input the
// user may be typing into.
function updateDevSection(state) {
  var b = bodyEl();
  if (!b) return false;
  var cur = b.querySelector("#ws-dev-section");
  if (!cur) return false;
  var tmp = document.createElement("div");
  tmp.innerHTML = devSectionHtml(state);
  var next = tmp.firstChild;
  cur.parentNode.replaceChild(next, cur);
  wireDevButton(next);
  wireLiveUiControls(next);
  refreshIcons();
  return true;
}

function render(state) {
  var b = bodyEl();
  if (!b) return;
  if (renderCoopOwnerControl()) return;
  // Preserve any in-progress "Add issue" typing across a re-render (notably the
  // partial→full two-phase update, which can land while the user is typing).
  var prevAdd = b.querySelector("#ws-add-input");
  var prevAddVal = prevAdd ? prevAdd.value : "";
  var prevAddFocused = prevAdd && document.activeElement === prevAdd;
  var html = "";

  html += workspaceSummaryHtml(state);

  // Dev / local environment
  html += devSectionHtml(state);

  html += linkedItemsHtml(state);

  // Session media
  if (state.sessionMedia && state.sessionMedia.length) {
    html += '<section class="ws-section"><div class="ws-section-heading">' +
      '<span>Session screenshots</span><i data-lucide="images"></i></div>' +
      sessionMediaHtml(state.sessionMedia) + '</section>';
  }

  b.innerHTML = html;
  wireBody(b);
  if (prevAddVal || prevAddFocused) {
    var newAdd = b.querySelector("#ws-add-input");
    if (newAdd) {
      newAdd.value = prevAddVal;
      if (prevAddFocused) { newAdd.focus(); newAdd.setSelectionRange(prevAddVal.length, prevAddVal.length); }
    }
  }
  refreshIcons();
}

function wireBody(b) {
  // Media tiles are plain target="_blank" links — clicking opens the image/
  // video in a new tab (top-level navigation, so GitHub auth + inline display
  // work) instead of downloading. Gracefully fall back broken thumbnails
  // (e.g. private images we can't load in-app) to a generic icon.
  var imgs = b.querySelectorAll(".ws-thumb img");
  for (var i = 0; i < imgs.length; i++) {
    imgs[i].addEventListener("error", function () {
      var a = this.parentNode;
      if (a) { a.classList.add("ws-thumb-link"); a.innerHTML = '<i data-lucide="image"></i>'; refreshIcons(); }
    });
  }
  // Open images/videos in the in-app lightbox instead of a new tab. Assets that
  // can't render in-app (private GitHub images whose thumbnail failed to load,
  // or non-media files) keep the anchor's native target=_blank — top-level
  // navigation is the only way those carry GitHub auth. Videos try the popup
  // and fall back to "Open in new tab" inside the modal if they can't play.
  var thumbs = b.querySelectorAll("a.ws-thumb");
  for (var t = 0; t < thumbs.length; t++) {
    thumbs[t].addEventListener("click", function (e) {
      var isVideo = this.classList.contains("ws-thumb-video");
      // ws-thumb-link = a non-image file, or an image whose preview failed.
      if (!isVideo && this.classList.contains("ws-thumb-link")) return;
      var url = this.getAttribute("href");
      if (!url) return;
      e.preventDefault();
      showMediaModal(url, isVideo ? "video" : "image");
    });
  }
  // Session screenshot actions: copy to clipboard / re-add to the composer.
  var copyBtns = b.querySelectorAll(".ws-shot-btn[data-copy]");
  for (var c = 0; c < copyBtns.length; c++) {
    copyBtns[c].addEventListener("click", function () { copyImageToClipboard(this.getAttribute("data-copy")); });
  }
  var addBtns = b.querySelectorAll(".ws-shot-btn[data-add]");
  for (var ad = 0; ad < addBtns.length; ad++) {
    addBtns[ad].addEventListener("click", function () {
      var btn = this;
      btn.disabled = true;
      addPendingImageFromUrl(btn.getAttribute("data-add"))
        .then(function () { showToast("Added to chat message", "success"); })
        .catch(function (e) { showToast("Couldn't add image: " + (e && e.message || e), "error"); })
        .then(function () { btn.disabled = false; });
    });
  }
  // Dev start/stop.
  wireDevButton(b);
  wireLiveUiControls(b);
  // Pin / unpin.
  var pinBtns = b.querySelectorAll(".ws-pin-btn");
  for (var p = 0; p < pinBtns.length; p++) {
    pinBtns[p].addEventListener("click", function () {
      var ref = (this.getAttribute("data-pin") || "").split("#");
      var pinned = this.getAttribute("data-pinned") === "1";
      if (ref.length !== 2) return;
      sendWs({ type: pinned ? "workspace_unpin_item" : "workspace_pin_item", slug: ref[0] || null, number: parseInt(ref[1], 10) });
    });
  }
  // Add issue.
  var addBtn = b.querySelector("#ws-add-btn");
  var addInput = b.querySelector("#ws-add-input");
  function submitAdd() {
    if (!addInput) return;
    var raw = addInput.value.trim();
    if (!raw) return;
    var slug = null;
    var number = null;
    var m = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/);
    if (m) { slug = m[1]; number = parseInt(m[2], 10); }
    else { var n = raw.match(/(\d+)/); if (n) number = parseInt(n[1], 10); }
    if (!number) return;
    sendWs({ type: "workspace_pin_item", slug: slug, number: number });
    addInput.value = "";
  }
  if (addBtn) addBtn.addEventListener("click", submitAdd);
  if (addInput) addInput.addEventListener("keydown", function (e) { if (e.key === "Enter") submitAdd(); });
}
