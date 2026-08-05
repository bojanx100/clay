// app-projects.js - Project list, switching, and project removal
// Extracted from app.js (PR-29)

import { showToast } from './utils.js';
import { refreshIcons } from './icons.js';
import { parseEmojis } from './markdown.js';
import { store } from './store.js';
import { getWs, setWs } from './ws-ref.js';
import { getMessagesEl, getStatusDot } from './dom-refs.js';
import { userAvatarUrl } from './avatar.js';
import { showConfirm } from './app-misc.js';
// renderUserStrip is now reactive via store subscriber in sidebar-mates.js
import { renderIconStrip } from './sidebar-projects.js';
import { updateCrossProjectBlink, stopUrgentBlink, setActivity } from './app-favicon.js';
import { spawnDustParticles } from './sidebar.js';
import { isSearchOpen, closeSearch } from './session-search.js';
import { exitDmMode } from './app-dm.js';
import { isHomeHubVisible, hideHomeHub, showHomeHub } from './app-home-hub.js';
import { closeArticle as closeWhatsNewArticle } from './whats-new-article.js';
import { resetFileBrowser } from './filebrowser.js';
import { closeArchive } from './sticky-notes.js';
import { hideMemory } from './mate-memory.js';
import { isSchedulerOpen, closeScheduler, resetScheduler } from './scheduler.js';
import { isProjectSettingsOpen, closeProjectSettings } from './project-settings.js';
import { connect, cancelReconnect, setStatus, sendUserAction } from './app-connection.js';
import { setTurnCounter, setPrependAnchor, setActivityEl, setIsUserScrolledUp, hideSuggestionChips } from './app-rendering.js';
import { resetToolState, enableMainInput, resetTurnMetaCost } from './tools.js';
import { restoreInputDraft, saveInputDraftForSession } from './input.js';
import { clearAllMentionActive } from './sidebar-mates.js';
import { setRewindMode } from './rewind.js';
import { resetUsage, resetContext } from './app-panels.js';
import { resetRateLimitState } from './app-rate-limit.js';
import { closeSessionInfoPopover } from './app-header.js';
import { resetDebateState } from './debate.js';
import { removeDebateBottomBar } from './app-debate-ui.js';
import { initAddProjectModal } from './add-project-modal.js';
import { rememberTabSessionRef, sessionRefUrlSuffix, syncTabSessionRefUrl } from './session-tab-state.js';

export { openAddProjectModal, closeAddProjectModal, handleBrowseDirResult, handleAddProjectResult, handleCloneProgress } from './add-project-modal.js';

// --- Module-owned state ---
var cachedProjects = [];
var cachedProjectCount = 0;
var cachedRemovedProjects = [];
var pendingRemoveSlug = null;
var pendingRemoveName = null;

export function initProjects() {
  initAddProjectModal();
}

// --- State accessors ---

export function getCachedProjects() { return cachedProjects; }
export function setCachedProjects(v) { cachedProjects = v; }
export function getCachedProjectCount() { return cachedProjectCount; }
export function setCachedProjectCount(v) { cachedProjectCount = v; }
export function getCachedRemovedProjects() { return cachedRemovedProjects; }
export function setCachedRemovedProjects(v) { cachedRemovedProjects = v; }

// --- Functions ---

export function updateProjectList(msg) {
  if (typeof msg.projectCount === "number") cachedProjectCount = msg.projectCount;

  // Compare projects before caching to detect actual changes
  var projectsChanged = false;
  if (msg.projects) {
    var projectsJson = JSON.stringify(msg.projects);
    if (projectsJson !== _lastProjectsJson) {
      projectsChanged = true;
      _lastProjectsJson = projectsJson;
    }
    cachedProjects = msg.projects;
  }
  if (msg.removedProjects) cachedRemovedProjects = msg.removedProjects;
  else if (msg.removedProjects === undefined) { /* keep cached */ }
  else cachedRemovedProjects = [];

  // Only re-render project strip + title bar if data or active slug changed
  var currentSlug = store.get('currentSlug');
  var slugChanged = currentSlug !== _lastRenderedSlug;
  if (projectsChanged || slugChanged) {
    _lastRenderedSlug = currentSlug;
    var count = cachedProjectCount || 0;
    renderProjectList();
    var projectHint = document.getElementById("project-hint");
    if (count === 1 && projectHint) {
      try {
        if (!localStorage.getItem("clay-project-hint-dismissed")) {
          projectHint.classList.remove("hidden");
        }
      } catch (e) {}
    } else if (projectHint) {
      projectHint.classList.add("hidden");
    }
  }

  // Update topbar with server-wide presence (renderTopbarPresence has its own guard)
  if (msg.serverUsers) {
    var newOnlineIds = msg.serverUsers.map(function (u) { return u.id; });
    var prevOnlineIds = store.get('cachedOnlineIds') || [];
    store.set({ cachedOnlineIds: newOnlineIds });
    renderTopbarPresence(msg.serverUsers);
    // renderUserStrip is handled by the store subscriber (fingerprint-guarded)
  }

  // Update user strip (DM targets) - renderUserStrip has its own fingerprint guard
  if (msg.allUsers) {
    store.set({ cachedAllUsers: msg.allUsers });
    if (msg.dmFavorites) store.set({ cachedDmFavorites: msg.dmFavorites });
    if (msg.dmConversations) store.set({ cachedDmConversations: msg.dmConversations });
    // renderUserStrip is handled by the store subscriber
    var st2 = store.snap();
    if (document.body.classList.contains("mate-dm-active") || document.body.classList.contains("wide-view")) {
      var refreshedMyUser = st2.cachedAllUsers.find(function (u) { return u.id === st2.myUserId; });
      if (refreshedMyUser) {
        document.body.dataset.myDisplayName = refreshedMyUser.displayName || refreshedMyUser.username || "";
        document.body.dataset.myAvatarUrl = userAvatarUrl(refreshedMyUser, 36);
        try { localStorage.setItem("clay_my_user", JSON.stringify({ displayName: refreshedMyUser.displayName, username: refreshedMyUser.username, avatarStyle: refreshedMyUser.avatarStyle, avatarSeed: refreshedMyUser.avatarSeed, avatarCustom: refreshedMyUser.avatarCustom })); } catch(e) {}
      }
    }
    // Render my avatar (always present, hidden behind user-island)
    var meEl = document.getElementById("icon-strip-me");
    if (meEl && !meEl.hasChildNodes()) {
      var myUser = st2.cachedAllUsers.find(function (u) { return u.id === st2.myUserId; });
      if (myUser) {
        var meAvatar = document.createElement("img");
        meAvatar.className = "icon-strip-me-avatar";
        meAvatar.src = userAvatarUrl(myUser, 34);
        meEl.appendChild(meAvatar);
      }
    }
  }
}

var _lastTopbarUserIds = [];
var _lastProjectsJson = "";
var _lastRenderedSlug = null;
export function renderTopbarPresence(serverUsers) {
  var countEl = document.getElementById("client-count");
  if (!countEl) return;
  if (serverUsers.length > 1) {
    // Skip re-render if user list unchanged
    var newIds = serverUsers.map(function (u) { return u.id; }).sort();
    if (newIds.length === _lastTopbarUserIds.length && newIds.every(function (id, i) { return id === _lastTopbarUserIds[i]; })) return;
    _lastTopbarUserIds = newIds;
    countEl.innerHTML = "";
    for (var cui = 0; cui < serverUsers.length; cui++) {
      var cu = serverUsers[cui];
      var cuImg = document.createElement("img");
      cuImg.className = "client-avatar";
      cuImg.src = userAvatarUrl(cu, 24);
      cuImg.alt = cu.displayName;
      cuImg.dataset.tip = cu.displayName + " (@" + cu.username + ")";
      if (cui > 0) cuImg.style.marginLeft = "-6px";
      countEl.appendChild(cuImg);
    }
    countEl.classList.remove("hidden");
  } else {
    _lastTopbarUserIds = [];
    countEl.classList.add("hidden");
  }
}

export function renderProjectList() {
  var iconStripProjects = cachedProjects.filter(function (p) {
    return !p.isMate;
  }).map(function (p) {
    return {
      slug: p.slug,
      name: p.title || p.project,
      icon: p.icon || null,
      isProcessing: p.isProcessing,
      onlineUsers: p.onlineUsers || [],
      unread: p.unread || 0,
      pendingPermissions: p.pendingPermissions || 0,
      isWorktree: p.isWorktree || false,
      parentSlug: p.parentSlug || null,
      branch: p.branch || null,
      worktreeAccessible: p.worktreeAccessible !== undefined ? p.worktreeAccessible : true,
    };
  });
  var st = store.snap();
  var iconStripActiveSlug = (st.mateProjectSlug && st.savedMainSlug) ? st.savedMainSlug : st.currentSlug;
  renderIconStrip(iconStripProjects, iconStripActiveSlug);
  // Update title bar project name and icon if it changed
  if (!st.mateProjectSlug) {
    for (var pi = 0; pi < cachedProjects.length; pi++) {
      if (cachedProjects[pi].slug === st.currentSlug) {
        var updatedName = cachedProjects[pi].title || cachedProjects[pi].project;
        var tbName = document.getElementById("title-bar-project-name");
        if (tbName && updatedName) tbName.textContent = updatedName;
        var tbIcon = document.getElementById("title-bar-project-icon");
        if (tbIcon) {
          var pIcon = cachedProjects[pi].icon || null;
          if (pIcon) {
            tbIcon.textContent = pIcon;
            parseEmojis(tbIcon);
            tbIcon.classList.add("has-icon");
            try { localStorage.setItem("clay-project-icon-" + (st.currentSlug || "default"), pIcon); } catch (e) {}
          } else {
            tbIcon.textContent = "";
            tbIcon.classList.remove("has-icon");
            try { localStorage.removeItem("clay-project-icon-" + (st.currentSlug || "default")); } catch (e) {}
          }
        }
        break;
      }
    }
  }
  // Re-apply current socket status to the active icon's dot
  var dot = getStatusDot();
  if (dot) {
    if (st.connected && st.processing) { dot.classList.add("connected"); dot.classList.add("processing"); }
    else if (st.connected) { dot.classList.add("connected"); }
  }
  updateCrossProjectBlink();
}

export function resetClientState() {
  if (isSearchOpen()) closeSearch();
  getMessagesEl().innerHTML = "";
  store.set({ currentMsgEl: null });
  store.set({ currentFullText: "" });
  store.set({ sessionVendorOverrides: {} });
  resetToolState();
  restoreInputDraft(null);
  clearAllMentionActive();
  setActivityEl(null);
  store.set({ processing: false });
  setTurnCounter(0);
  store.set({ messageUuidMap: [] });
  store.set({ historyFrom: 0 });
  store.set({ historyTotal: 0 });
  setPrependAnchor(null);
  store.set({ loadingMore: false });
  setIsUserScrolledUp(false);
  document.getElementById("new-msg-btn").classList.add("hidden");
  setRewindMode(false);
  setActivity(null);
  setStatus("connected");
  if (!store.get('loopActive')) enableMainInput();
  resetUsage();
  resetTurnMetaCost();
  resetContext();
  resetRateLimitState();
  var headerCtx = store.get('headerContextEl');
  if (headerCtx) { headerCtx.remove(); store.set({ headerContextEl: null }); }
  hideSuggestionChips();
  closeSessionInfoPopover();
  stopUrgentBlink();
  // Clear debate UI and state from previous session
  store.set({ debateStickyState: null });
  resetDebateState();
  var debateBadges = document.querySelectorAll(".debate-header-badge");
  for (var dbi = 0; dbi < debateBadges.length; dbi++) debateBadges[dbi].remove();
  removeDebateBottomBar();
  var handBar = document.getElementById("debate-hand-raise-bar");
  if (handBar) handBar.remove();
  var debateSticky = document.getElementById("debate-sticky");
  if (debateSticky) { debateSticky.classList.add("hidden"); debateSticky.innerHTML = ""; }
  var debateFloat = document.getElementById("debate-info-float");
  if (debateFloat) { debateFloat.classList.add("hidden"); debateFloat.innerHTML = ""; }
}

export function switchProject(slug, options) {
  if (!slug) return;
  var st = store.snap();
  if (st.currentSlug && st.activeSessionId) {
    saveInputDraftForSession(st.currentSlug, st.activeSessionId);
  }
  var wasDm = st.dmMode;
  var wasMate = st.dmMode && st.dmTargetUser && st.dmTargetUser.isMate;
  if (st.dmMode) exitDmMode(wasMate);
  closeWhatsNewArticle();
  if (isHomeHubVisible()) {
    hideHomeHub();
    if (slug === store.get('currentSlug')) return;
  }
  if (slug === store.get('currentSlug')) {
    if (wasDm) {
      sendUserAction({ type: "switch_session", id: store.get('activeSessionId') });
    }
    return;
  }
  resetFileBrowser();
  closeArchive();
  hideMemory();
  if (isProjectSettingsOpen()) closeProjectSettings();
  if (isSchedulerOpen()) closeScheduler();
  resetScheduler(slug);
  store.set({ currentSlug: slug });
  store.set({ basePath: "/p/" + slug + "/" });
  store.set({ wsPath: "/p/" + slug + "/ws" });
  if (document.documentElement.classList.contains("pwa-standalone")) {
    history.replaceState(null, "", "/p/" + slug + "/" + sessionRefUrlSuffix(options && options.sessionRef));
  } else {
    history.pushState(null, "", "/p/" + slug + "/" + sessionRefUrlSuffix(options && options.sessionRef));
  }
  resetClientState();
  connect();
}

// Resolving a global SessionRef happens while the browser is still connected
// to Coop.  Persist the durable reference before opening the target socket so
// the target project restores the exact session instead of creating a default
// one.  Resolver failures are handled by the global projection UI and never
// reach this function.
export function openResolvedGlobalSession(resolution) {
  if (!resolution || !resolution.ref || !resolution.slug || typeof resolution.localId !== "number") return false;
  rememberTabSessionRef(resolution.slug, resolution.ref, resolution.localId);
  store.set({ activeGlobalSessionRef: resolution.ref });
  if (resolution.slug === store.get('currentSlug')) {
    syncTabSessionRefUrl(resolution.slug, resolution.ref);
    return sendUserAction({ type: "switch_session", id: resolution.localId });
  }
  switchProject(resolution.slug, { sessionRef: resolution.ref });
  return true;
}

export function showUpdateAvailable(msg) {
  // Update the settings panel button only (top bar pill replaced by notification center)
  var settingsUpdBtn = document.getElementById("settings-update-check");
  if (settingsUpdBtn && msg.version) {
    settingsUpdBtn.innerHTML = "";
    var ic = document.createElement("i");
    ic.setAttribute("data-lucide", "arrow-up-circle");
    settingsUpdBtn.appendChild(ic);
    settingsUpdBtn.appendChild(document.createTextNode(" Update available (v" + msg.version + ")"));
    settingsUpdBtn.classList.add("settings-btn-update-available");
    settingsUpdBtn.disabled = false;
    refreshIcons();
  }
}

// --- Remove project ---

export function confirmRemoveProject(slug, name) {
  pendingRemoveSlug = slug;
  pendingRemoveName = name;
  sendUserAction({ type: "remove_project_check", slug: slug });
}

export function handleRemoveProjectCheckResult(msg) {
  var slug = msg.slug || pendingRemoveSlug;
  var name = msg.name || pendingRemoveName || slug;
  if (!slug) return;

  if (msg.count > 0) {
    showRemoveProjectTaskDialog(slug, name, msg.count);
  } else {
    var isWt = slug.indexOf("--") !== -1;
    var confirmMsg = isWt
      ? 'Delete worktree "' + name + '"? The branch and working directory will be removed from disk.'
      : 'Remove "' + name + '"? You can re-add it later.';
    showConfirm(confirmMsg, function () {
      var iconEl = document.querySelector('.icon-strip-item[data-slug="' + slug + '"]');
      if (iconEl) {
        var rect = iconEl.getBoundingClientRect();
        spawnDustParticles(rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
      setTimeout(function () {
        sendUserAction({ type: "remove_project", slug: slug });
      }, 1000);
    }, "Remove", true);
  }
  pendingRemoveSlug = null;
  pendingRemoveName = null;
}

function showRemoveProjectTaskDialog(slug, name, taskCount) {
  var otherProjects = cachedProjects.filter(function (p) { return p.slug !== slug; });

  var modal = document.createElement("div");
  modal.className = "remove-project-task-modal";
  modal.innerHTML =
    '<div class="remove-project-task-backdrop"></div>' +
    '<div class="remove-project-task-dialog">' +
      '<div class="remove-project-task-title">Remove project "' + (name || slug) + '"</div>' +
      '<div class="remove-project-task-text">This project has <strong>' + taskCount + '</strong> task' + (taskCount > 1 ? 's' : '') + '/schedule' + (taskCount > 1 ? 's' : '') + '.</div>' +
      '<div class="remove-project-task-options">' +
        (otherProjects.length > 0
          ? '<div class="remove-project-task-label">Move tasks to:</div>' +
            '<select class="remove-project-task-select" id="rpt-move-target">' +
              otherProjects.map(function (p) {
                return '<option value="' + p.slug + '">' + (p.title || p.project || p.slug) + '</option>';
              }).join("") +
            '</select>' +
            '<button class="remove-project-task-btn move" id="rpt-move-btn">Move &amp; Remove</button>'
          : '') +
        '<button class="remove-project-task-btn delete" id="rpt-delete-btn">Delete all &amp; Remove</button>' +
        '<button class="remove-project-task-btn cancel" id="rpt-cancel-btn">Cancel</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  var backdrop = modal.querySelector(".remove-project-task-backdrop");
  var moveBtn = modal.querySelector("#rpt-move-btn");
  var deleteBtn = modal.querySelector("#rpt-delete-btn");
  var cancelBtn = modal.querySelector("#rpt-cancel-btn");
  var selectEl = modal.querySelector("#rpt-move-target");

  function close() { modal.remove(); }
  backdrop.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);

  if (moveBtn) {
    moveBtn.addEventListener("click", function () {
      var targetSlug = selectEl ? selectEl.value : null;
      if (targetSlug) sendUserAction({ type: "remove_project", slug: slug, moveTasksTo: targetSlug });
      close();
    });
  }

  deleteBtn.addEventListener("click", function () {
    sendUserAction({ type: "remove_project", slug: slug });
    close();
  });
}

export function handleRemoveProjectResult(msg) {
  if (msg.ok) {
    var currentSlug = store.get('currentSlug');
    if (msg.slug === currentSlug) {
      var isWorktree = msg.slug.indexOf("--") !== -1;
      var parentSlug = isWorktree ? msg.slug.split("--")[0] : null;

      showToast(isWorktree ? "Worktree removed" : "Project removed", "success");

      // Suppress disconnect overlay and reconnect by detaching the WS
      var ws = getWs();
      if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); setWs(null); }
      cancelReconnect();
      store.set({ connected: false });
      document.getElementById("connect-overlay").classList.add("hidden");
      if (!isWorktree) {
        var removedProj = null;
        for (var ri = 0; ri < cachedProjects.length; ri++) {
          if (cachedProjects[ri].slug === msg.slug) { removedProj = cachedProjects[ri]; break; }
        }
        if (removedProj) {
          cachedRemovedProjects.push({
            path: removedProj.path || "",
            title: removedProj.title || null,
            icon: removedProj.icon || null,
            removedAt: Date.now(),
          });
        }
      }
      cachedProjects = cachedProjects.filter(function (p) { return p.slug !== msg.slug; });
      cachedProjectCount = cachedProjects.length;
      store.set({ currentSlug: null });
      renderProjectList();
      resetClientState();

      if (parentSlug) {
        switchProject(parentSlug);
      } else {
        showHomeHub();
      }
    } else {
      showToast(msg.slug.indexOf("--") !== -1 ? "Worktree removed" : "Project removed", "success");
    }
  } else {
    showToast(msg.error || "Failed to remove project", "error");
  }
}
