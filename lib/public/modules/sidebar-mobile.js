// sidebar-mobile.js - Mobile sheet overlays, tab bar, and mobile-specific rendering
// Extracted from sidebar.js (PR-38)

import { mateAvatarUrl } from './avatar.js';
import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { parseEmojis } from './markdown.js';
import { getCurrentTheme, getChatLayout, setChatLayout } from './theme.js';
import { openCommandPalette } from './command-palette.js';
import { getMateSessions } from './mate-sidebar.js';
import { openProjectSettings } from './project-settings.js';
import { getUpcomingSchedules } from './scheduler.js';
import {
  getCachedSessions,
  isSessionListLoading,
  getDateGroup,
  getAutoLaunchActivitySummary,
  getSessionProviderColorClass,
  openAutoLaunchActivity,
  openImportSessionPicker,
  openSessionActionMenu,
  resolveDefaultVendor,
  startNewSession
} from './sidebar-sessions.js';
import { VENDOR_AVATARS, VENDOR_NAMES, VENDOR_ORDER, VENDOR_HOMEPAGES } from './vendor-ui.js';
import {
  getCachedProjectList,
  getCachedCurrentSlug,
  getProjectAbbrev
} from './sidebar-projects.js';
import {
  getCurrentDmUserId,
  getCachedMates,
  getCachedDmFavorites,
  getCachedDmUnread,
  getCachedDmRemovedUsers
} from './sidebar-mates.js';

import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { dismissOverlayPanels, closeSidebar } from './sidebar.js';
import { switchProject, getCachedProjects, openResolvedGlobalSession } from './app-projects.js';
import { sendUserAction } from './app-connection.js';
import { openDm } from './app-dm.js';
import { showHomeHub } from './app-home-hub.js';
import { openTerminal } from './terminal.js';
import { requestKnowledgeList } from './mate-knowledge.js';
import { loadRootDirectory } from './filebrowser.js';
import {
  buildMobileCoordinatorItems,
  buildMobileOwnershipSections,
  createMobileCoordinatorGroup
} from './sidebar-mobile-coordinators.js';
import {
  createMobileLeadProjectItem,
  filterLeadProjects,
  findVisibleLeadProject
} from './sidebar-lead.js';
import {
  buildGlobalCoopDisplayModel,
} from './global-coop-projection.js';
import { renderCoopTopicSections } from './sidebar-coop-topics.js';
import { sessionsForOrdinaryProjectSidebar } from './sidebar-sessions-model.js';
import { aggregateFamily, familyOf, parentProjects } from './worktree-family.js';

// --- Mobile state ---
var mobileChatSheetOpen = false;
var mobileSheetMateData = null;
var expandedMobileLoopGroups = new Set();
var expandedMobileLoopRuns = new Set();
var AUTOLAUNCH_REC_ID = "autolaunch_assigned";
var mobileAutoLaunchActivityRequested = false;

function appendMobileSessionProcessing(parent, s) {
  if (!s || !s.isProcessing || s.coopHome) return null;
  var dot = document.createElement("span");
  dot.className = "mobile-session-processing " + getSessionProviderColorClass(s);
  parent.appendChild(dot);
  return dot;
}

window.addEventListener("clay:auto-launch-activity", function () {
  if (!mobileChatSheetOpen) return;
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) return;
  var listEl = sheet.querySelector(".mobile-sheet-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  renderMobileSessionsInto(listEl);
});

// Repaint an open projects sheet when the project list lands. Without this the
// switcher can be opened before the first list arrives and stay on its loading
// placeholder until the owner backs out and reopens it.
window.addEventListener("clay:project-list-updated", function () {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) return;
  var titleEl = sheet.querySelector(".mobile-sheet-title");
  var listEl = sheet.querySelector(".mobile-sheet-list");
  if (!titleEl || !listEl || titleEl.textContent !== "Projects") return;
  listEl.innerHTML = "";
  renderSheetProjects(listEl);
});

export function setMobileSheetMateData(data) {
  mobileSheetMateData = data;
}

export function openMobileSheet(type) {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet) return;

  var titleEl = sheet.querySelector(".mobile-sheet-title");
  var listEl = sheet.querySelector(".mobile-sheet-list");
  if (!titleEl || !listEl) return;

  restoreMobileSheetMovedContent(sheet);
  listEl.innerHTML = "";
  sheet.classList.remove("sheet-files", "sheet-knowledge");
  renderMobileSheetType(type, sheet, titleEl, listEl);

  sheet.classList.remove("hidden", "closing");
  refreshIcons();
}

function restoreMobileSheetMovedContent(sheet) {
  if (sheet.classList.contains("sheet-files")) {
    var prevFileTree = document.getElementById("file-tree");
    var prevPanel = document.getElementById("sidebar-panel-files");
    if (prevFileTree && prevPanel) prevPanel.appendChild(prevFileTree);
  }
  if (sheet.classList.contains("sheet-knowledge")) {
    var prevKnowledge = document.getElementById("mate-knowledge-files");
    var prevKnowledgePanel = document.getElementById("mate-sidebar-knowledge");
    if (prevKnowledge && prevKnowledgePanel) prevKnowledgePanel.appendChild(prevKnowledge);
  }
}

// The switcher pill is static markup, so it is present no matter what the
// projection or the session list currently holds. Only its visibility depends
// on which sheet is open: offer "Projects" from the chat/topic sheet, and
// "Chat" back out of the projects sheet so the drill-in is not a dead end.
function updateMobileSheetNav(type) {
  var projectsBtn = document.getElementById("mobile-sheet-projects-btn");
  var backBtn = document.getElementById("mobile-sheet-back-btn");
  if (projectsBtn) projectsBtn.hidden = type !== "sessions";
  if (backBtn) backBtn.hidden = type !== "projects";
}

function renderMobileSheetType(type, sheet, titleEl, listEl) {
  updateMobileSheetNav(type);
  // Drilling out of the chat sheet must drop the live-refresh flag, or a later
  // session/auto-launch update would repaint session rows over whatever sheet
  // is now on screen.
  if (type !== "sessions") mobileChatSheetOpen = false;
  if (type === "projects") {
    titleEl.textContent = "Projects";
    renderSheetProjects(listEl);
  } else if (type === "sessions") {
    titleEl.textContent = "Chat";
    renderSheetSessions(listEl);
  } else if (type === "files") {
    titleEl.textContent = "Files";
    sheet.classList.add("sheet-files");
    var fileTree = document.getElementById("file-tree");
    if (fileTree) {
      listEl.appendChild(fileTree);
      fileTree.classList.remove("hidden");
    }
    loadRootDirectory();
  } else if (type === "mate-knowledge") {
    titleEl.textContent = "Knowledge";
    sheet.classList.add("sheet-knowledge");
    var knowledgeFiles = document.getElementById("mate-knowledge-files");
    if (knowledgeFiles) {
      listEl.appendChild(knowledgeFiles);
      knowledgeFiles.classList.remove("hidden");
    }
    // Request knowledge list if not loaded
    requestKnowledgeList();
  } else if (type === "mate-profile") {
    titleEl.textContent = "";
    renderSheetMateProfile(listEl);
  } else if (type === "search") {
    titleEl.textContent = "Search";
    renderSheetSearch(listEl);
  } else if (type === "tools") {
    titleEl.textContent = "Tools";
    renderSheetTools(listEl);
  } else if (type === "settings") {
    titleEl.textContent = "Settings";
    renderSheetSettings(listEl);
  }
}

function closeMobileSheet() {
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) return;

  mobileChatSheetOpen = false;

  // Return file tree to sidebar if it was moved
  if (sheet.classList.contains("sheet-files")) {
    var fileTree = document.getElementById("file-tree");
    var sidebarFilesPanel = document.getElementById("sidebar-panel-files");
    if (fileTree && sidebarFilesPanel) {
      sidebarFilesPanel.appendChild(fileTree);
    }
  }
  // Return knowledge files to mate sidebar if moved
  if (sheet.classList.contains("sheet-knowledge")) {
    var knowledgeFiles = document.getElementById("mate-knowledge-files");
    var knowledgePanel = document.getElementById("mate-sidebar-knowledge");
    if (knowledgeFiles && knowledgePanel) {
      knowledgePanel.appendChild(knowledgeFiles);
    }
  }

  sheet.classList.add("closing");
  setTimeout(function () {
    sheet.classList.add("hidden");
    sheet.classList.remove("closing", "sheet-files");
  }, 230);
}

function finishMobileCoopNavigation() {
  dismissOverlayPanels();
  closeMobileSheet();
}

// Build a single tappable project row (used for parents and worktrees).
function buildMobileProjectRow(p, isWorktree) {
  var el = document.createElement("button");
  var isAccessible = !isWorktree || p.worktreeAccessible !== false;
  el.className = "mobile-project-item"
    + (p.slug === getCachedCurrentSlug() ? " active" : "")
    + (isWorktree ? " wt-item" : "")
    + (!isAccessible ? " wt-disabled" : "");

  var abbrev = document.createElement("span");
  abbrev.className = "mobile-project-abbrev";
  if (p.icon) {
    abbrev.textContent = p.icon;
    parseEmojis(abbrev);
  } else {
    abbrev.textContent = getProjectAbbrev(p.name);
  }
  el.appendChild(abbrev);

  var name = document.createElement("span");
  name.className = "mobile-project-name";
  name.textContent = p.name;
  el.appendChild(name);

  if (p.isProcessing) {
    var dot = document.createElement("span");
    dot.className = "mobile-project-processing";
    el.appendChild(dot);
  }

  if (p.unread > 0 && p.slug !== getCachedCurrentSlug()) {
    var mBadge = document.createElement("span");
    mBadge.className = "mobile-project-unread";
    mBadge.textContent = p.unread > 99 ? "99+" : String(p.unread);
    el.appendChild(mBadge);
  }

  if (isAccessible) {
    el.addEventListener("click", function () {
      if (switchProject) switchProject(p.slug);
      closeMobileSheet();
    });
  } else {
    el.disabled = true;
  }

  return el;
}

function renderSheetProjects(listEl) {
  var projects = getCachedProjectList();
  // The switcher is reachable before the first project list lands (or while a
  // reconnect is in flight). Say so instead of rendering a blank sheet that
  // reads as "you have no projects".
  if (!projects || projects.length === 0) {
    var empty = document.createElement("div");
    empty.className = "mobile-project-empty";
    empty.textContent = "Loading projects…";
    listEl.appendChild(empty);
    return;
  }
  var leadProject = findVisibleLeadProject(projects);
  if (leadProject) {
    listEl.appendChild(createMobileLeadProjectItem(leadProject, getCachedCurrentSlug(), function (slug) {
      if (switchProject) switchProject(slug);
      closeMobileSheet();
    }));
  }

  var visibleProjects = filterLeadProjects(projects);
  var parents = parentProjects(visibleProjects);
  var activeFamily = familyOf(visibleProjects, getCachedCurrentSlug());
  var activeSlug = activeFamily.parent ? activeFamily.parent.slug : getCachedCurrentSlug();
  for (var i = 0; i < parents.length; i++) {
    (function (p) {
      var family = familyOf(visibleProjects, p.slug);
      var display = aggregateFamily(p, family.worktrees);
      var row = buildMobileProjectRow(display, false);
      row.classList.toggle("active", p.slug === activeSlug);
      listEl.appendChild(row);
    })(parents[i]);
  }
  refreshIcons();
}

// Mates are opt-in. users-preferences.js stores the decision as `matesEnabled`
// and treats only the literal true as on, and the server default is off, so the
// flag is the authority. Mobile used to gate the chips on isMultiUserMode
// instead: any multi-user server rendered mates even with them disabled, and a
// cached mate list kept them on screen after a reconnect or restart that had
// already turned them off.
//
// Read live on every render rather than captured, so a disable, a reconnect, a
// restart, or any rerender drops stale rows on the spot. The store subscription
// below repaints an already-open sheet the moment the flag flips.
function mobileMatesEnabled() {
  return store.get('matesEnabled') === true && !!store.get('isMultiUserMode');
}

function visibleMobileChatMates() {
  if (!mobileMatesEnabled()) return [];
  return getCachedMates().filter(function (m) {
    if (getCachedDmRemovedUsers()[m.id]) return false;
    if (getCachedDmFavorites().indexOf(m.id) !== -1) return true;
    if (getCachedDmUnread()[m.id] && getCachedDmUnread()[m.id] > 0) return true;
    return false;
  });
}

function renderSheetSessions(listEl) {
  mobileChatSheetOpen = true;
  if (getCachedCurrentSlug() === "lead") {
    renderMobileSessionsInto(listEl);
    return;
  }

  // --- Mate DM chips (horizontal scroll) ---
  //
  // Project chips used to live here too, which meant the chat sheet carried a
  // second project switcher stacked under the header's "Projects" control --
  // two entry points in ordinary projects, and (before the header control
  // existed) zero in Coop, because this whole bar was skipped there. The header
  // control is now the single project-switch entry point on every surface, so
  // this bar carries mates only. Do not reintroduce project chips here.
  var filterBar = document.createElement("div");
  filterBar.className = "mobile-chat-filter-bar";

  var chips = [];

  var sortedChipMates = visibleMobileChatMates().sort(function (a, b) {
    var aBuiltin = a.builtinKey ? 1 : 0;
    var bBuiltin = b.builtinKey ? 1 : 0;
    if (aBuiltin !== bBuiltin) return bBuiltin - aBuiltin;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  for (var mi = 0; mi < sortedChipMates.length; mi++) {
    (function (mate) {
      var mp = mate.profile || {};
      var chip = document.createElement("button");
      chip.className = "mobile-chat-chip";
      if (getCurrentDmUserId() === mate.id) chip.classList.add("active");
      chip.dataset.type = "mate";
      chip.dataset.mateId = mate.id;

      var avatarEl = document.createElement("img");
      avatarEl.className = "mobile-chat-chip-avatar";
      avatarEl.src = mateAvatarUrl(mate, 20);
      avatarEl.alt = mp.displayName || mate.name || "";
      chip.appendChild(avatarEl);

      var label = document.createElement("span");
      label.textContent = mp.displayName || mate.name || "Mate";
      chip.appendChild(label);

      // Processing dot: same class as icon strip, same data source
      var mateSlug = "mate-" + mate.id;
      var mateProj = null;
      var allProjects = getCachedProjects() || [];
      for (var pi = 0; pi < allProjects.length; pi++) {
        if (allProjects[pi].slug === mateSlug) { mateProj = allProjects[pi]; break; }
      }
      var statusDot = document.createElement("span");
      statusDot.className = "icon-strip-status";
      if (mateProj && mateProj.isProcessing) statusDot.classList.add("processing");
      chip.appendChild(statusDot);

      var unreadCount = getCachedDmUnread()[mate.id] || 0;
      if (unreadCount > 0) {
        var badge = document.createElement("span");
        badge.className = "mobile-chat-chip-badge";
        badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
        chip.appendChild(badge);
      }

      chips.push(chip);
    })(sortedChipMates[mi]);
  }

  for (var i = 0; i < chips.length; i++) {
    filterBar.appendChild(chips[i]);
  }
  // No mates to show means no bar at all, rather than an empty strip above the
  // session list.
  if (chips.length > 0) listEl.appendChild(filterBar);

  // --- Session list container ---
  var sessionListEl = document.createElement("div");
  sessionListEl.className = "mobile-chat-session-list";
  listEl.appendChild(sessionListEl);

  // --- Render sessions for a context ---
  function renderSessionsForContext(type, slug, mateId) {
    sessionListEl.innerHTML = "";

    if (type === "project") {
      renderMobileSessionsInto(sessionListEl);
    } else if (type === "mate") {
      // Mate DM: open the DM and show mate actions
      openDm(mateId);
      renderMateMobileActions(sessionListEl);
    }

    refreshIcons();
  }

  // --- Chip click handlers ---
  for (var j = 0; j < chips.length; j++) {
    (function (chip) {
      chip.addEventListener("click", function () {
        // Deactivate all chips
        for (var k = 0; k < chips.length; k++) {
          chips[k].classList.remove("active");
        }
        chip.classList.add("active");

        // Mates only: project switching belongs to the header control.
        if (chip.dataset.type === "mate") {
          renderSessionsForContext("mate", null, chip.dataset.mateId);
        }
      });
    })(chips[j]);
  }


  // --- Initial render: show mate actions if DM active, otherwise project sessions ---
  if (getCurrentDmUserId()) {
    renderSessionsForContext("mate", null, getCurrentDmUserId());
  } else {
    renderSessionsForContext("project", getCachedCurrentSlug(), null);
  }
}

// Helper: create a mobile session item element
function createMobileSessionItem(s) {
  var el = createMobileSessionBase(s);
  var orchestrationParent = s.orchestrationGroupParent || s.orchestrationParent;
  applyMobileWorkerColor(el, orchestrationParent);
  appendMobileWorkerMetadata(el, s, orchestrationParent);
  appendMobileSessionProcessing(el, s);
  appendMobileFavoriteIcon(el, s);
  el.appendChild(createMobileSessionTitle(s, orchestrationParent));
  appendMobileUnreadBadge(el, s);
  el.appendChild(createMobileSessionActionButton(s));
  bindMobileSessionSwitch(el, s.id);
  return el;
}

function createMobileSessionBase(s) {
  var el = document.createElement("div");
  el.className = "mobile-session-item" + (s.bookmarked ? " bookmarked" : "") + (s.active ? " active" : "");
  el.dataset.sessionId = s.id;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  var vendor = s.vendor || "claude";
  var vendorIcon = document.createElement("img");
  vendorIcon.className = "mobile-session-vendor-icon";
  vendorIcon.src = VENDOR_AVATARS[vendor] || VENDOR_AVATARS.claude;
  vendorIcon.alt = "";
  el.appendChild(vendorIcon);
  return el;
}

function applyMobileWorkerColor(el, orchestrationParent) {
  if (orchestrationParent && orchestrationParent.workerColor) {
    el.style.setProperty("--worker-color", orchestrationParent.workerColor);
  }
}

function appendMobileWorkerMetadata(el, s, orchestrationParent) {
  if (!orchestrationParent) return;
  var details = [];
  if (orchestrationParent.taskStatus) {
    var status = String(orchestrationParent.taskStatus).replace(/_/g, " ");
    details.push(status.charAt(0).toUpperCase() + status.slice(1));
  }
  var attemptCount = Number(orchestrationParent.attemptCount) || 0;
  var attempt = Number(orchestrationParent.attempt) || 0;
  if (attemptCount > 1) details.push("Worker attempt " + attempt + " of " + attemptCount);
  if (details.length === 0) return;
  var label = (s.title || "New Session") + " — " + details.join(" · ");
  el.setAttribute("aria-label", label);
  el.title = label;
}

function appendMobileFavoriteIcon(el, s) {
  if (s.bookmarked) {
    var favoriteIcon = document.createElement("span");
    favoriteIcon.className = "mobile-session-favorite";
    favoriteIcon.innerHTML = iconHtml("star");
    favoriteIcon.setAttribute("aria-label", "Favorite");
    el.appendChild(favoriteIcon);
  }
}

function createMobileSessionTitle(s, orchestrationParent) {
  var titleSpan = document.createElement("span");
  titleSpan.className = "mobile-session-title";
  appendMobileLeadGlyph(titleSpan, s, orchestrationParent);
  appendMobileAutoBadge(titleSpan, s);
  titleSpan.appendChild(document.createTextNode(s.title || "New Session"));
  return titleSpan;
}

function appendMobileLeadGlyph(titleSpan, s, orchestrationParent) {
  if (!s.leadOwned || orchestrationParent || s.coopHome) return;
  var glyph = document.createElement("span");
  glyph.className = "mobile-session-lead-glyph";
  glyph.textContent = "🧭";
  glyph.setAttribute("role", "img");
  glyph.setAttribute("aria-label", "Lead-controlled session");
  glyph.title = "Lead-controlled session";
  titleSpan.appendChild(glyph);
}

function appendMobileAutoBadge(titleSpan, s) {
  if (s.taskLauncher && s.taskLauncher.autoLaunch) {
    var isPrFix = s.taskLauncher.kind === "pr-review";
    var autoBadge = document.createElement("span");
    autoBadge.className = "mobile-session-auto-badge" + (isPrFix ? " pr" : "");
    autoBadge.textContent = isPrFix ? "PR fix" : "Auto";
    titleSpan.appendChild(autoBadge);
  }
}

function appendMobileUnreadBadge(el, s) {
  if (s.unread > 0 && !s.active) {
    var badge = document.createElement("span");
    badge.className = "mobile-session-unread";
    badge.textContent = s.unread > 99 ? "99+" : String(s.unread);
    el.appendChild(badge);
  }
}

function createMobileSessionActionButton(s) {
  var actionBtn = document.createElement("span");
  actionBtn.className = "mobile-session-action";
  actionBtn.innerHTML = iconHtml("ellipsis");
  actionBtn.setAttribute("role", "button");
  actionBtn.setAttribute("aria-label", "Session actions");
  actionBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    openSessionActionMenu(actionBtn, s);
  });
  return actionBtn;
}

function bindMobileSessionSwitch(el, sessionId) {
  (function (id) {
    el.addEventListener("click", function () {
      if (sendUserAction({ type: "switch_session", id: id })) {
        if (dismissOverlayPanels) dismissOverlayPanels();
        closeMobileSheet();
      }
    });
  })(sessionId);
}

function formatMobileCountdown(ms) {
  var sec = Math.max(0, Math.ceil(ms / 1000));
  var h = Math.floor(sec / 3600);
  var m = Math.floor((sec % 3600) / 60);
  var s = sec % 60;
  if (h > 0) return h + "h " + (m < 10 ? "0" : "") + m + "m";
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function currentProjectForSettings() {
  var slug = getCachedCurrentSlug();
  var projects = getCachedProjectList();
  var proj = null;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === slug) {
      proj = projects[i];
      break;
    }
  }
  if (proj && proj.isMate && getCachedMates().length > 0) {
    var mateId = slug.replace("mate-", "");
    var mates = getCachedMates();
    for (var mi = 0; mi < mates.length; mi++) {
      var mp = mates[mi].profile || {};
      if (mates[mi].id === mateId) {
        proj = Object.assign({}, proj, { name: mp.displayName || mates[mi].name || proj.name });
        break;
      }
    }
  }
  if (proj && store.get('ownerLocked')) proj = Object.assign({}, proj, { ownerLocked: true });
  return proj;
}

function createMobileAutoLaunchRow() {
  var schedules = getUpcomingSchedules(Number.MAX_SAFE_INTEGER);
  var autoLaunch = null;
  for (var i = 0; i < schedules.length; i++) {
    if (schedules[i].id === AUTOLAUNCH_REC_ID) {
      autoLaunch = schedules[i];
      break;
    }
  }
  if (!autoLaunch) return null;

  var row = document.createElement("button");
  row.className = "mobile-autolaunch-row";

  var icon = document.createElement("span");
  icon.className = "mobile-autolaunch-icon";
  icon.innerHTML = iconHtml("timer");
  row.appendChild(icon);

  var label = document.createElement("span");
  label.className = "mobile-autolaunch-label";
  label.textContent = autoLaunch.name || "Auto-launch";
  row.appendChild(label);

  var activity = getAutoLaunchActivitySummary();
  if (!store.get('connected')) {
    mobileAutoLaunchActivityRequested = false;
  } else if (!mobileAutoLaunchActivityRequested && getWs()) {
    getWs().send(JSON.stringify({ type: "get_auto_launch_activity" }));
    mobileAutoLaunchActivityRequested = true;
  }
  // Show FINISHED work only (completed today); in-progress sessions already
  // appear in the session list, so a "started" count would just be noise.
  if (activity.doneToday > 0) {
    var done = document.createElement("span");
    done.className = "mobile-autolaunch-activity done";
    done.innerHTML = iconHtml("check") + String(activity.doneToday);
    row.appendChild(done);
  }

  var badge = document.createElement("span");
  badge.className = "mobile-autolaunch-countdown";
  badge.textContent = formatMobileCountdown(autoLaunch.nextRunAt - Date.now());
  row.appendChild(badge);

  row.addEventListener("click", function () {
    openAutoLaunchActivity(row);
  });

  return row;
}

// Helper: create a mobile loop child element (individual session inside a group)
function createMobileLoopChild(s) {
  var el = document.createElement("div");
  el.className = "mobile-loop-child" + (s.active ? " active" : "");
  el.dataset.sessionId = s.id;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");

  appendMobileSessionProcessing(el, s);

  var textSpan = document.createElement("span");
  textSpan.className = "mobile-session-title";
  if (s.loop) {
    var isRalphChild = s.loop.source === "ralph";
    var roleName = s.loop.role === "crafting" ? "Crafting" : s.loop.role === "judge" ? "Judge" : (isRalphChild ? "Coder" : "Run");
    var iterSuffix = s.loop.role === "crafting" ? "" : " #" + s.loop.iteration;
    var roleCls = s.loop.role === "crafting" ? " crafting" : (!isRalphChild ? " scheduled" : "");
    var badge = document.createElement("span");
    badge.className = "mobile-loop-role-badge" + roleCls;
    badge.textContent = roleName + iterSuffix;
    textSpan.appendChild(badge);
  }
  el.appendChild(textSpan);

  var actionBtn = document.createElement("span");
  actionBtn.className = "mobile-session-action";
  actionBtn.innerHTML = iconHtml("ellipsis");
  actionBtn.setAttribute("role", "button");
  actionBtn.setAttribute("aria-label", "Session actions");
  actionBtn.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    openSessionActionMenu(actionBtn, s);
  });
  el.appendChild(actionBtn);

  (function (id) {
    el.addEventListener("click", function () {
      if (sendUserAction({ type: "switch_session", id: id })) {
        if (dismissOverlayPanels) dismissOverlayPanels();
        closeMobileSheet();
      }
    });
  })(s.id);

  return el;
}

// Helper: create a mobile loop run sub-group (collapsible time group)
function createMobileLoopRun(parentGk, startedAtKey, sessions, isRalph) {
  var runGk = parentGk + ":" + startedAtKey;
  var expanded = expandedMobileLoopRuns.has(runGk);
  var startedAt = Number(startedAtKey);
  var timeLabel = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Unknown";

  var hasActive = false;
  var processingSession = null;
  var latestSession = sessions[0];
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].active) hasActive = true;
    if (sessions[i].isProcessing) {
      if (!processingSession) processingSession = sessions[i];
    }
    if ((sessions[i].lastActivity || 0) > (latestSession.lastActivity || 0)) {
      latestSession = sessions[i];
    }
  }

  var wrapper = document.createElement("div");
  wrapper.className = "mobile-loop-run-wrapper";

  var header = document.createElement("button");
  header.className = "mobile-loop-run" + (hasActive ? " active" : "") + (expanded ? " expanded" : "") + (isRalph ? "" : " scheduled");

  var chevron = document.createElement("span");
  chevron.className = "mobile-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  header.appendChild(chevron);

  var label = document.createElement("span");
  label.className = "mobile-loop-run-time";
  appendMobileSessionProcessing(label, processingSession);
  label.appendChild(document.createTextNode(timeLabel));
  header.appendChild(label);

  var countBadge = document.createElement("span");
  countBadge.className = "mobile-loop-count" + (isRalph ? "" : " scheduled");
  countBadge.textContent = String(sessions.length);
  header.appendChild(countBadge);

  header.addEventListener("click", (function (rk) {
    return function (e) {
      e.stopPropagation();
      if (expandedMobileLoopRuns.has(rk)) {
        expandedMobileLoopRuns.delete(rk);
      } else {
        expandedMobileLoopRuns.add(rk);
      }
      refreshMobileChatSheet();
    };
  })(runGk));

  wrapper.appendChild(header);

  if (expanded) {
    var childContainer = document.createElement("div");
    childContainer.className = "mobile-loop-children";
    for (var k = 0; k < sessions.length; k++) {
      childContainer.appendChild(createMobileLoopChild(sessions[k]));
    }
    wrapper.appendChild(childContainer);
  }

  return wrapper;
}

// Helper: create a mobile loop group element (collapsible group header)
function createMobileLoopGroup(loopId, children, groupKey) {
  var gk = groupKey || loopId;
  var runs = buildMobileLoopRuns(children);
  var summary = summarizeMobileLoopChildren(children);
  var expanded = expandedMobileLoopGroups.has(gk);
  var wrapper = document.createElement("div");
  wrapper.className = "mobile-loop-wrapper";
  wrapper.appendChild(createMobileLoopGroupHeader(gk, children, runs, summary, expanded));
  appendMobileLoopExpandedChildren(wrapper, gk, runs, expanded, summary.isRalph);
  return wrapper;
}

function buildMobileLoopRuns(children) {
  var runMap = {};
  for (var i = 0; i < children.length; i++) {
    var runKey = String(children[i].loop && children[i].loop.startedAt || 0);
    if (!runMap[runKey]) runMap[runKey] = [];
    runMap[runKey].push(children[i]);
  }
  var runKeys = Object.keys(runMap);

  // Sort each run's children by iteration then role
  for (var ri = 0; ri < runKeys.length; ri++) {
    runMap[runKeys[ri]].sort(function (a, b) {
      var ai = (a.loop && a.loop.iteration) || 0;
      var bi = (b.loop && b.loop.iteration) || 0;
      if (ai !== bi) return ai - bi;
      var ar = (a.loop && a.loop.role === "judge") ? 1 : 0;
      var br = (b.loop && b.loop.role === "judge") ? 1 : 0;
      return ar - br;
    });
  }

  runKeys.sort(function (a, b) { return Number(b) - Number(a); });
  return { map: runMap, keys: runKeys };
}

function compareMobileLoopChildren(a, b) {
  var ai = (a.loop && a.loop.iteration) || 0;
  var bi = (b.loop && b.loop.iteration) || 0;
  if (ai !== bi) return ai - bi;
  var ar = (a.loop && a.loop.role === "judge") ? 1 : 0;
  var br = (b.loop && b.loop.role === "judge") ? 1 : 0;
  return ar - br;
}

function summarizeMobileLoopChildren(children) {
  var hasActive = false;
  var processingSession = null;
  var latestSession = children[0];
  var isCrafting = false;
  for (var i = 0; i < children.length; i++) {
    if (children[i].active) hasActive = true;
    if (children[i].isProcessing && !processingSession) processingSession = children[i];
    if ((children[i].lastActivity || 0) > (latestSession.lastActivity || 0)) latestSession = children[i];
    if (children[i].loop && children[i].loop.role === "crafting") isCrafting = true;
  }
  return {
    hasActive: hasActive,
    processingSession: processingSession,
    loopName: (children[0].loop && children[0].loop.name) || "Loop",
    isRalph: children[0].loop && children[0].loop.source === "ralph",
    isCrafting: isCrafting
  };
}

function createMobileLoopGroupHeader(gk, children, runs, summary, expanded) {
  var header = document.createElement("button");
  header.className = "mobile-loop-group" + (summary.hasActive ? " active" : "") + (expanded ? " expanded" : "") + (summary.isRalph ? "" : " scheduled");

  var chevron = document.createElement("span");
  chevron.className = "mobile-loop-chevron";
  chevron.innerHTML = iconHtml("chevron-right");
  header.appendChild(chevron);

  var iconSpan = document.createElement("span");
  var groupIcon = summary.isRalph ? "repeat" : "calendar-clock";
  iconSpan.className = "mobile-loop-icon" + (summary.isRalph ? "" : " scheduled");
  iconSpan.innerHTML = iconHtml(groupIcon);
  header.appendChild(iconSpan);

  appendMobileSessionProcessing(header, summary.processingSession);

  var nameSpan = document.createElement("span");
  nameSpan.className = "mobile-loop-name";
  nameSpan.textContent = summary.loopName;
  header.appendChild(nameSpan);

  appendMobileLoopGroupBadge(header, children, runs.keys.length, summary);
  bindMobileLoopGroupToggle(header, gk);
  return header;
}

function appendMobileLoopGroupBadge(header, children, runCount, summary) {
  if (summary.isCrafting && children.length === 1) {
    var craftBadge = document.createElement("span");
    craftBadge.className = "mobile-loop-badge crafting";
    craftBadge.textContent = "Crafting";
    header.appendChild(craftBadge);
    return;
  }
  var countBadge = document.createElement("span");
  countBadge.className = "mobile-loop-count" + (summary.isRalph ? "" : " scheduled");
  countBadge.textContent = runCount === 1 ? String(children.length) : runCount + " runs";
  header.appendChild(countBadge);
}

function bindMobileLoopGroupToggle(header, gk) {
  header.addEventListener("click", (function (lid) {
    return function (e) {
      e.stopPropagation();
      if (expandedMobileLoopGroups.has(lid)) {
        expandedMobileLoopGroups.delete(lid);
      } else {
        expandedMobileLoopGroups.add(lid);
      }
      refreshMobileChatSheet();
    };
  })(gk));
}

function appendMobileLoopExpandedChildren(wrapper, gk, runs, expanded, isRalph) {
  if (!expanded) return;
  var childContainer = document.createElement("div");
  childContainer.className = "mobile-loop-children";
  if (runs.keys.length === 1) {
    appendMobileLoopSingleRun(childContainer, runs.map[runs.keys[0]]);
  } else {
    appendMobileLoopRunGroups(childContainer, gk, runs, isRalph);
  }
  wrapper.appendChild(childContainer);
}

function appendMobileLoopSingleRun(childContainer, singleRun) {
  for (var i = 0; i < singleRun.length; i++) {
    childContainer.appendChild(createMobileLoopChild(singleRun[i]));
  }
}

function appendMobileLoopRunGroups(childContainer, gk, runs, isRalph) {
  for (var i = 0; i < runs.keys.length; i++) {
    childContainer.appendChild(createMobileLoopRun(gk, runs.keys[i], runs.map[runs.keys[i]], isRalph));
  }
}

function renderMateMobileActions(container) {
  var newSessionBtn = document.createElement("button");
  newSessionBtn.className = "mobile-session-new";
  newSessionBtn.innerHTML = '<i data-lucide="plus" style="width:16px;height:16px"></i> New session';
  newSessionBtn.addEventListener("click", function () {
    if (sendUserAction({ type: "new_session" })) closeMobileSheet();
  });
  container.appendChild(newSessionBtn);

  var debateBtn = document.createElement("button");
  debateBtn.className = "mobile-session-new";
  debateBtn.innerHTML = '<i data-lucide="mic" style="width:16px;height:16px"></i> New debate';
  debateBtn.addEventListener("click", function () {
    closeMobileSheet();
    var targetBtn = document.getElementById("mate-debate-btn");
    if (targetBtn) setTimeout(function () { targetBtn.click(); }, 250);
  });
  container.appendChild(debateBtn);

  // Render mate session list
  var mateSessions = getMateSessions();
  if (mateSessions.length > 0) {
    var sorted = mateSessions.slice().sort(function (a, b) {
      return (b.lastActivity || 0) - (a.lastActivity || 0);
    });

    var currentGroup = "";
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      var group = getDateGroup(s.lastActivity || 0);
      if (group !== currentGroup) {
        currentGroup = group;
        var header = document.createElement("div");
        header.className = "mobile-sheet-group";
        header.textContent = group;
        container.appendChild(header);
      }
      var mateItem = createMobileSessionItem(s);
      container.appendChild(mateItem);
    }
  }

  refreshIcons();
}

// Helper: render sorted sessions into a container with date groups (with loop session grouping)
function createMobileNewSessionRow(container) {
  var defaultVendor = resolveDefaultVendor();
  var installed = store.get('installedVendors') || [];
  var newRow = document.createElement("div");
  newRow.className = "mobile-session-new-row";

  var mainBtn = document.createElement("button");
  mainBtn.className = "mobile-session-new mobile-session-new-main";
  mainBtn.innerHTML = '<img src="' + (VENDOR_AVATARS[defaultVendor] || VENDOR_AVATARS.claude) +
    '" class="mobile-session-new-icon" alt=""><span>New ' + (VENDOR_NAMES[defaultVendor] || defaultVendor) + ' session</span>';
  mainBtn.addEventListener("click", function () {
    startNewSession(defaultVendor);
    closeMobileSheet();
  });
  newRow.appendChild(mainBtn);

  var vendorList = document.createElement("div");
  vendorList.className = "mobile-vendor-list hidden";

  var chevronBtn = document.createElement("button");
  chevronBtn.className = "mobile-session-new mobile-session-new-chevron";
  chevronBtn.setAttribute("aria-label", "Choose a vendor");
  chevronBtn.innerHTML = iconHtml("chevron-down");
  chevronBtn.addEventListener("click", function () {
    vendorList.classList.toggle("hidden");
    chevronBtn.classList.toggle("expanded");
  });
  newRow.appendChild(chevronBtn);

  // Every known vendor is listed. Uninstalled ones stay visible but disabled,
  // and tapping one opens the vendor's homepage.
  for (var vi = 0; vi < VENDOR_ORDER.length; vi++) {
    (function (vendor) {
      var isInstalled = installed.indexOf(vendor) !== -1;
      var name = VENDOR_NAMES[vendor] || vendor;
      var vBtn = document.createElement("button");
      vBtn.className = "mobile-session-new mobile-session-new-vendor";
      if (!isInstalled) vBtn.classList.add("disabled");
      if (vendor === defaultVendor) vBtn.classList.add("active");
      vBtn.innerHTML = '<img src="' + VENDOR_AVATARS[vendor] + '" class="mobile-session-new-icon" alt="">' +
        '<span>' + name + '</span>' +
        (isInstalled ? "" : '<span class="mobile-vendor-note">Not installed</span>');
      vBtn.addEventListener("click", function () {
        if (!isInstalled) {
          window.open(VENDOR_HOMEPAGES[vendor], "_blank", "noopener");
          return;
        }
        startNewSession(vendor);
        closeMobileSheet();
      });
      vendorList.appendChild(vBtn);
    })(VENDOR_ORDER[vi]);
  }

  var importBtn = document.createElement("button");
  importBtn.className = "mobile-session-new mobile-session-import";
  importBtn.innerHTML = iconHtml("download") + '<span>Import</span>';
  importBtn.addEventListener("click", function () {
    openImportSessionPicker("");
  });
  newRow.appendChild(importBtn);
  container.appendChild(newRow);
  container.appendChild(vendorList);

  return newRow;
}

function shouldHideMobileLoopSession(session) {
  return session.loop && session.loop.loopId && session.loop.role === "crafting" && session.loop.source !== "ralph" && session.loop.source !== "debate";
}

function mobileLoopGroupKey(session) {
  var startedAt = session.loop.startedAt || 0;
  var dateStr = startedAt ? new Date(startedAt).toISOString().slice(0, 10) : "unknown";
  return session.loop.loopId + ":" + dateStr;
}

function partitionMobileSessions(sessions) {
  var loopGroups = {};
  var normalSessions = [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (shouldHideMobileLoopSession(session)) continue;
    if (session.loop && session.loop.loopId) {
      var groupKey = mobileLoopGroupKey(session);
      if (!loopGroups[groupKey]) loopGroups[groupKey] = [];
      loopGroups[groupKey].push(session);
    } else {
      normalSessions.push(session);
    }
  }
  return { loopGroups: loopGroups, normalSessions: normalSessions };
}

function mobileLoopGroupActivity(children) {
  var maxActivity = 0;
  for (var i = 0; i < children.length; i++) {
    var activity = children[i].lastActivity || 0;
    if (activity > maxActivity) maxActivity = activity;
  }
  return maxActivity;
}

function appendMobileLoopItems(items, loopGroups) {
  var groupKeys = Object.keys(loopGroups);
  for (var i = 0; i < groupKeys.length; i++) {
    var groupKey = groupKeys[i];
    var children = loopGroups[groupKey];
    items.push({
      type: "loop",
      loopId: children[0].loop.loopId,
      groupKey: groupKey,
      children: children,
      lastActivity: mobileLoopGroupActivity(children)
    });
  }
}

function isMobileBookmarkedItem(item) {
  return item.type !== "loop" && item.data && item.data.bookmarked;
}

function sortMobileSessionItems(items) {
  items.sort(function (a, b) {
    var aBookmarked = !!isMobileBookmarkedItem(a);
    var bBookmarked = !!isMobileBookmarkedItem(b);
    if (aBookmarked !== bBookmarked) return aBookmarked ? -1 : 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });
}

function splitMobileSessionItems(items) {
  var split = { bookmarkedItems: [], regularItems: [] };
  for (var i = 0; i < items.length; i++) {
    if (isMobileBookmarkedItem(items[i])) {
      split.bookmarkedItems.push(items[i]);
    } else {
      split.regularItems.push(items[i]);
    }
  }
  return split;
}

function appendMobileSheetGroup(container, label) {
  var header = document.createElement("div");
  header.className = "mobile-sheet-group";
  header.textContent = label;
  container.appendChild(header);
}

function createMobileSessionListNode(item) {
  if (item.type === "loop") return createMobileLoopGroup(item.loopId, item.children, item.groupKey);
  if (item.type === "coordinator") {
    return createMobileCoordinatorGroup(item, {
      createSessionItem: createMobileSessionItem,
      rerender: refreshMobileChatSheet
    });
  }
  return createMobileSessionItem(item.data);
}

function appendMobileBookmarkedItems(container, bookmarkedItems) {
  if (bookmarkedItems.length <= 0) return;
  appendMobileSheetGroup(container, "Favorites");
  for (var i = 0; i < bookmarkedItems.length; i++) {
    container.appendChild(createMobileSessionListNode(bookmarkedItems[i]));
  }
}

function appendMobileRegularItems(container, regularItems) {
  var currentGroup = "";
  for (var i = 0; i < regularItems.length; i++) {
    var item = regularItems[i];
    var group = getDateGroup(item.lastActivity || 0);
    if (group !== currentGroup) {
      currentGroup = group;
      if (group !== "Today") appendMobileSheetGroup(container, group);
    }
    container.appendChild(createMobileSessionListNode(item));
  }
}

function appendMobileOwnershipSections(container, ownershipSections) {
  for (var i = 0; i < ownershipSections.length; i++) {
    var section = ownershipSections[i];
    appendMobileSheetGroup(container, section.label);
    appendMobileRegularItems(container, section.items);
  }
}

function renderMobileGlobalCoopSessions(container) {
  renderCoopTopicSections(container, buildGlobalCoopDisplayModel(""), {
    mobile: true,
    onNavigate: finishMobileCoopNavigation,
    onToggle: refreshMobileChatSheet,
    openSession: openResolvedGlobalSession,
    openProject: switchProject,
  });
}

// Helper: render sorted sessions into a container with date groups (with loop session grouping)
function renderMobileSessionsInto(container) {
  if (isSessionListLoading()) {
    var loading = document.createElement("div");
    loading.className = "mobile-session-list-target-loading";
    loading.dataset.projectSlug = store.get("currentSlug") || "";
    loading.textContent = "Loading conversations…";
    container.appendChild(loading);
    return;
  }
  if (store.get("currentSlug") === "lead") {
    renderMobileGlobalCoopSessions(container);
    return;
  }
  // Vendor-aware new-session row. Mirrors the desktop sidebar's two-button
  // pattern (Claude defaults to TUI, Codex always GUI) so mobile users can
  // pick the vendor instead of being silently routed to Claude TUI.
  createMobileNewSessionRow(container);

  var autoLaunchRow = createMobileAutoLaunchRow();
  if (autoLaunchRow) container.appendChild(autoLaunchRow);

  var partitioned = partitionMobileSessions(
    sessionsForOrdinaryProjectSidebar(getCachedSessions())
  );
  var items = buildMobileCoordinatorItems(partitioned.normalSessions);
  appendMobileLoopItems(items, partitioned.loopGroups);
  sortMobileSessionItems(items);

  var split = splitMobileSessionItems(items);
  appendMobileBookmarkedItems(container, split.bookmarkedItems);
  appendMobileOwnershipSections(container, buildMobileOwnershipSections(split.regularItems));
}

// Refresh mobile chat sheet when session data updates (called from renderSessionList)
// Mate chips only -- the bar no longer carries project chips.
function updateMobileChatChipActive(chip, currentDmUserId) {
  chip.classList.remove("active");
  if (chip.dataset.type === "mate" && chip.dataset.mateId === currentDmUserId) chip.classList.add("active");
}

function isMobileChatChipProcessing(chip, projects) {
  // Mate chips only; a mate's backing project is slugged "mate-<id>".
  if (chip.dataset.type !== "mate") return false;
  var lookupSlug = "mate-" + chip.dataset.mateId;
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === lookupSlug && projects[i].isProcessing) return true;
  }
  return false;
}

function updateMobileChatChipProcessing(chip, projects) {
  var statusDot = chip.querySelector(".icon-strip-status");
  if (!statusDot) return;
  statusDot.classList.toggle("processing", isMobileChatChipProcessing(chip, projects));
}

function refreshMobileChatChips(sheet) {
  var chips = sheet.querySelectorAll(".mobile-chat-chip");
  var currentDmUserId = getCurrentDmUserId();
  var projects = getCachedProjects() || [];
  // Mates can be turned off while the sheet is open, and a reconnect or restart
  // can arrive with them already off. Drop rows the flag no longer authorises
  // instead of leaving the cached ones on screen.
  if (!mobileMatesEnabled()) {
    for (var d = chips.length - 1; d >= 0; d--) {
      if (chips[d].dataset.type === "mate" && chips[d].parentNode) chips[d].parentNode.removeChild(chips[d]);
    }
    var emptyBar = sheet.querySelector(".mobile-chat-filter-bar");
    if (emptyBar && emptyBar.children.length === 0 && emptyBar.parentNode) {
      emptyBar.parentNode.removeChild(emptyBar);
    }
    return;
  }
  for (var i = 0; i < chips.length; i++) {
    updateMobileChatChipActive(chips[i], currentDmUserId);
    updateMobileChatChipProcessing(chips[i], projects);
  }
}

function renderMobileChatSessions(sessionListEl) {
  sessionListEl.innerHTML = "";
  if (getCurrentDmUserId()) {
    renderMateMobileActions(sessionListEl);
    return;
  }
  renderMobileSessionsInto(sessionListEl);
}

// Refresh mobile chat sheet when session data updates (called from renderSessionList)
export function refreshMobileChatSheet() {
  if (!mobileChatSheetOpen) return;
  var sheet = document.getElementById("mobile-sheet");
  if (!sheet || sheet.classList.contains("hidden")) {
    mobileChatSheetOpen = false;
    return;
  }
  var sessionListEl = sheet.querySelector(".mobile-chat-session-list");
  if (!sessionListEl) {
    // Coop renders topic sections straight into the sheet list and never builds
    // a .mobile-chat-session-list, so this returned early and the sheet never
    // repainted -- which is why tapping Main did nothing on a phone. Re-render
    // the whole list rather than giving up.
    var listEl = sheet.querySelector(".mobile-sheet-list");
    var titleEl = sheet.querySelector(".mobile-sheet-title");
    if (!listEl || !titleEl || titleEl.textContent !== "Chat") return;
    listEl.innerHTML = "";
    renderSheetSessions(listEl);
    refreshIcons();
    return;
  }

  refreshMobileChatChips(sheet);
  renderMobileChatSessions(sessionListEl);
  refreshIcons();
}

store.subscribe(function (state, previous) {
  // Same reason as the desktop sidebar: All -> Main changes no lens ref, so the
  // scope has to be watched directly or the sheet never repaints.
  if (state.activeCoopLens !== previous.activeCoopLens ||
      state.activeCoopLensScope !== previous.activeCoopLensScope ||
      state.coopConversationState !== previous.coopConversationState ||
      // Resolving a decision must drop that row from the open sheet, not wait
      // for the next unrelated re-render.
      state.coopActionQueue !== previous.coopActionQueue ||
      state.coopActionPending !== previous.coopActionPending ||
      state.coopActionError !== previous.coopActionError ||
      state.coopActionDone !== previous.coopActionDone ||
      state.coopDoneSectionOpen !== previous.coopDoneSectionOpen) refreshMobileChatSheet();
  // The authoritative mates state arrives after the profile fetch and can flip
  // at any time. Repaint an open sheet so disabling mates removes Buzz and Arch
  // immediately rather than at the next unrelated refresh.
  if (state.matesEnabled !== previous.matesEnabled ||
      state.isMultiUserMode !== previous.isMultiUserMode ||
      state.cachedMatesList !== previous.cachedMatesList) {
    refreshMobileChatSheet();
  }
});

function renderSheetMateProfile(listEl) {
  if (!mobileSheetMateData) return;
  var data = mobileSheetMateData;

  // Profile header
  var header = document.createElement("div");
  header.className = "mate-profile-header";

  var avatar = document.createElement("img");
  avatar.className = "mate-profile-avatar";
  avatar.src = data.avatarUrl || "";
  avatar.alt = data.displayName || "";
  header.appendChild(avatar);

  var info = document.createElement("div");
  info.className = "mate-profile-info";
  var nameEl = document.createElement("div");
  nameEl.className = "mate-profile-name";
  nameEl.textContent = data.displayName || "";
  info.appendChild(nameEl);
  if (data.description) {
    var descEl = document.createElement("div");
    descEl.className = "mate-profile-desc";
    descEl.textContent = data.description;
    info.appendChild(descEl);
  }
  header.appendChild(info);
  listEl.appendChild(header);

  // Action buttons
  var actions = [
    { icon: "book-open", label: "Knowledge", btnId: "mate-knowledge-btn", countId: "mate-knowledge-count" },
    { icon: "sticky-note", label: "Sticky Notes", btnId: "sticky-notes-sidebar-btn", countId: "sticky-notes-sidebar-count" },
    { icon: "puzzle", label: "Skills", btnId: "mate-skills-btn" },
    { icon: "calendar", label: "Scheduled Tasks", btnId: "mate-scheduler-btn" }
  ];

  for (var i = 0; i < actions.length; i++) {
    (function (action) {
      var btn = document.createElement("button");
      btn.className = "mate-profile-action";
      var countHtml = "";
      if (action.countId) {
        var countEl = document.getElementById(action.countId);
        if (countEl && !countEl.classList.contains("hidden") && countEl.textContent) {
          countHtml = '<span class="mate-profile-action-count">' + escapeHtml(countEl.textContent) + '</span>';
        }
      }
      btn.innerHTML = '<i data-lucide="' + action.icon + '"></i><span>' + action.label + '</span>' + countHtml;
      btn.addEventListener("click", function () {
        closeMobileSheet();
        var targetBtn = document.getElementById(action.btnId);
        if (targetBtn) {
          setTimeout(function () { targetBtn.click(); }, 250);
        }
      });
      listEl.appendChild(btn);
    })(actions[i]);
  }
}

function renderSheetSearch(listEl) {
  // Search input at top
  var wrap = document.createElement("div");
  wrap.className = "mobile-search-input-wrap";
  var input = document.createElement("input");
  input.className = "mobile-search-input";
  input.type = "text";
  input.placeholder = "Search sessions, messages...";
  input.autocomplete = "off";
  input.spellcheck = false;
  wrap.appendChild(input);
  listEl.appendChild(wrap);

  // Results container
  var resultsEl = document.createElement("div");
  resultsEl.style.padding = "0 8px";
  listEl.appendChild(resultsEl);

  // Auto-focus
  setTimeout(function () { input.focus(); }, 300);

  // Show all sessions initially
  renderSearchResults(resultsEl, "");

  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    renderSearchResults(resultsEl, q);
  });
  input.addEventListener("keydown", function (e) { e.stopPropagation(); });
  input.addEventListener("keyup", function (e) { e.stopPropagation(); });
  input.addEventListener("keypress", function (e) { e.stopPropagation(); });
}

function renderSearchResults(container, query) {
  container.innerHTML = "";
  var sorted = getCachedSessions().slice().sort(function (a, b) {
    if (!!a.bookmarked !== !!b.bookmarked) return a.bookmarked ? -1 : 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  var found = 0;
  for (var i = 0; i < sorted.length; i++) {
    var s = sorted[i];
    var title = s.title || "New Session";
    if (query && title.toLowerCase().indexOf(query) === -1) continue;
    found++;

    var el = document.createElement("button");
    el.className = "mobile-session-item";
    el.dataset.sessionId = s.id;
    if (s.active) el.classList.add("active");

    var titleSpan = document.createElement("span");
    titleSpan.className = "mobile-session-title";
    titleSpan.appendChild(document.createTextNode(title));
    el.appendChild(titleSpan);

    appendMobileSessionProcessing(el, s);

    (function (id) {
      el.addEventListener("click", function () {
        if (sendUserAction({ type: "switch_session", id: id })) {
          if (dismissOverlayPanels) dismissOverlayPanels();
          closeMobileSheet();
        }
      });
    })(s.id);

    container.appendChild(el);
  }

  if (found === 0 && query) {
    var empty = document.createElement("div");
    empty.className = "mobile-alert-empty";
    empty.textContent = 'No results for "' + query + '"';
    container.appendChild(empty);
  }
}

function renderSheetTools(listEl) {
  var isMateDm = document.body.classList.contains("mate-dm-active");

  var items = isMateDm ? [
    { icon: "brain", label: "Memory", action: "mate-memory" },
    { icon: "book-open", label: "Knowledge", action: "mate-knowledge" },
    { icon: "sticky-note", label: "Sticky Notes", action: "mate-sticky" },
    { icon: "puzzle", label: "Skills", action: "mate-skills" },
    { icon: "calendar-clock", label: "Scheduled Tasks", action: "mate-scheduler" }
  ] : [
    { icon: "folder-tree", label: "Files", action: "files" },
    { icon: "square-terminal", label: "Terminal", action: "terminal" },
    { icon: "calendar-clock", label: "Scheduled Tasks", action: "scheduler" }
  ];

  // Surface the Dashboard tool on mobile when it's available for the current
  // project. The desktop dashboard-btn always exists but is hidden via the
  // palette-tile--proj-hidden class unless the active project matches; mirror
  // that gating here so the item only shows when it would work.
  if (!isMateDm) {
    var dashBtn = document.getElementById("dashboard-btn");
    if (dashBtn && !dashBtn.classList.contains("palette-tile--proj-hidden")) {
      items.push({ icon: "layout-dashboard", label: "Dashboard", action: "dashboard" });
    }
  }

  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var btn = document.createElement("button");
      btn.className = "mobile-more-item";
      btn.innerHTML = '<i data-lucide="' + item.icon + '"></i><span class="mobile-more-item-label">' + item.label + '</span>';
      btn.addEventListener("click", function () {
        closeMobileSheet();
        var targetId = null;
        if (item.action === "files") {
          setTimeout(function () { openMobileSheet("files"); }, 250);
        } else if (item.action === "terminal") {
          openTerminal();
        } else if (item.action === "scheduler") {
          targetId = "scheduler-btn";
        } else if (item.action === "dashboard") {
          targetId = "dashboard-btn";
        } else if (item.action === "mate-knowledge") {
          setTimeout(function () { openMobileSheet("mate-knowledge"); }, 250);
          return;
        } else if (item.action === "mate-sticky") {
          targetId = "mate-sticky-notes-btn";
        } else if (item.action === "mate-skills") {
          targetId = "mate-skills-btn";
        } else if (item.action === "mate-memory") {
          targetId = "mate-memory-btn";
        } else if (item.action === "mate-scheduler") {
          targetId = "mate-scheduler-btn";
        } else if (item.action === "mate-debate") {
          targetId = "mate-debate-btn";
        }
        if (targetId) {
          var targetBtn = document.getElementById(targetId);
          if (targetBtn) setTimeout(function () { targetBtn.click(); }, 250);
        }
      });
      listEl.appendChild(btn);
    })(items[i]);
  }
}

function renderSheetSettings(listEl) {
  var items = [
    { icon: "folder-cog", label: "Project Settings", action: "project-settings" },
    { icon: "settings", label: "Server Settings", action: "server-settings" }
  ];

  for (var i = 0; i < items.length; i++) {
    (function (item) {
      var btn = document.createElement("button");
      btn.className = "mobile-more-item";
      btn.innerHTML = '<i data-lucide="' + item.icon + '"></i><span class="mobile-more-item-label">' + item.label + '</span>';
      btn.addEventListener("click", function () {
        closeMobileSheet();
        if (item.action === "project-settings") {
          setTimeout(function () {
            // Find current project data
            var proj = null;
            for (var pi = 0; pi < getCachedProjectList().length; pi++) {
              if (getCachedProjectList()[pi].slug === getCachedCurrentSlug()) {
                proj = getCachedProjectList()[pi];
                break;
              }
            }
            // For mate projects, use mate display name instead of slug
            if (proj && proj.isMate && getCachedMates().length > 0) {
              var mateId = getCachedCurrentSlug().replace("mate-", "");
              var _mates = getCachedMates();
              for (var mi = 0; mi < _mates.length; mi++) {
                var mp = _mates[mi].profile || {};
                if (_mates[mi].id === mateId) {
                  proj = Object.assign({}, proj, { name: mp.displayName || _mates[mi].name || proj.name });
                  break;
                }
              }
            }
            if (proj && store.get('ownerLocked')) proj = Object.assign({}, proj, { ownerLocked: true });
            openProjectSettings(getCachedCurrentSlug(), proj);
          }, 250);
        } else if (item.action === "server-settings") {
          var settingsBtn = document.getElementById("server-settings-btn");
          if (settingsBtn) setTimeout(function () { settingsBtn.click(); }, 250);
        }
      });
      listEl.appendChild(btn);
    })(items[i]);
  }

  // Dark/Light switch button
  var isDark = getCurrentTheme().variant === "dark";
  var themeBtn = document.createElement("button");
  themeBtn.className = "mobile-more-item";
  themeBtn.innerHTML = '<i data-lucide="' + (isDark ? "sun" : "moon") + '"></i><span class="mobile-more-item-label">Switch to ' + (isDark ? "Light" : "Dark") + '</span>';

  themeBtn.addEventListener("click", function () {
    var themeToggle = document.getElementById("theme-toggle-check");
    if (themeToggle) themeToggle.click();
    // Update button text after a tick (theme applies async)
    setTimeout(function () {
      var nowDark = getCurrentTheme().variant === "dark";
      themeBtn.innerHTML = '<i data-lucide="' + (nowDark ? "sun" : "moon") + '"></i><span class="mobile-more-item-label">Switch to ' + (nowDark ? "Light" : "Dark") + '</span>';
      refreshIcons();
    }, 50);
  });

  listEl.appendChild(themeBtn);

  // Chat Layout switch button
  var currentLayout = getChatLayout();
  var isBubble = currentLayout === "bubble";
  var layoutBtn = document.createElement("button");
  layoutBtn.className = "mobile-more-item";
  layoutBtn.innerHTML = '<i data-lucide="' + (isBubble ? "monitor" : "message-circle") + '"></i>'
    + '<span class="mobile-more-item-label">Switch to ' + (isBubble ? "Channel" : "Bubble") + '</span>';

  layoutBtn.addEventListener("click", function () {
    var next = getChatLayout() === "bubble" ? "channel" : "bubble";
    setChatLayout(next);
    fetch('/api/user/chat-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: next })
    });
    closeMobileSheet();
  });

  listEl.appendChild(layoutBtn);

  // "Open as app" -- only show if not already in PWA standalone mode
  if (!document.documentElement.classList.contains("pwa-standalone")) {
    var pwaBtn = document.createElement("button");
    pwaBtn.className = "mobile-more-item";
    pwaBtn.innerHTML = '<i data-lucide="smartphone"></i><span class="mobile-more-item-label">Open as app</span>';
    pwaBtn.addEventListener("click", function () {
      closeMobileSheet();
      // Trigger the existing PWA install modal
      var installPill = document.getElementById("pwa-install-pill");
      if (installPill) {
        setTimeout(function () { installPill.click(); }, 250);
      }
    });
    listEl.appendChild(pwaBtn);
  }
}

var mobileSidebarInitialized = false;

export function initSidebarMobile() {
  // Every listener below is an anonymous closure, so a second init would bind a
  // second copy of each and fire the switcher once per duplicate binding. The
  // renders are idempotent today, but the guard makes that independent of a
  // caller ever being added -- one init, one set of listeners, one control.
  if (mobileSidebarInitialized) return;
  mobileSidebarInitialized = true;

  // --- Mobile sheet close handlers ---
  var mobileSheet = document.getElementById("mobile-sheet");
  if (mobileSheet) {
    var sheetBackdrop = mobileSheet.querySelector(".mobile-sheet-backdrop");
    var sheetCloseBtn = mobileSheet.querySelector(".mobile-sheet-close");
    if (sheetBackdrop) sheetBackdrop.addEventListener("click", closeMobileSheet);
    if (sheetCloseBtn) sheetCloseBtn.addEventListener("click", closeMobileSheet);

    // Project switcher drill-in. Bound once here rather than per render so the
    // control keeps working across every later sheet render.
    var sheetProjectsBtn = document.getElementById("mobile-sheet-projects-btn");
    var sheetBackBtn = document.getElementById("mobile-sheet-back-btn");
    if (sheetProjectsBtn) {
      sheetProjectsBtn.addEventListener("click", function () { openMobileSheet("projects"); });
    }
    if (sheetBackBtn) {
      sheetBackBtn.addEventListener("click", function () { openMobileSheet("sessions"); });
    }

    // --- Drag to dismiss sheet ---
    var sheetHandle = mobileSheet.querySelector(".mobile-sheet-handle");
    var sheetContent = mobileSheet.querySelector(".mobile-sheet-content");
    if (sheetHandle && sheetContent) {
      var dragStartY = 0;
      var dragging = false;

      sheetHandle.addEventListener("touchstart", function (e) {
        dragStartY = e.touches[0].clientY;
        dragging = true;
        sheetContent.style.transition = "none";
      }, { passive: true });

      mobileSheet.addEventListener("touchmove", function (e) {
        if (!dragging) return;
        var deltaY = e.touches[0].clientY - dragStartY;
        if (deltaY < 0) deltaY = 0;
        sheetContent.style.transform = "translateY(" + deltaY + "px)";
        if (sheetBackdrop) {
          var opacity = Math.max(0, 1 - deltaY / (sheetContent.offsetHeight * 0.5));
          sheetBackdrop.style.opacity = opacity;
        }
      }, { passive: true });

      mobileSheet.addEventListener("touchend", function () {
        if (!dragging) return;
        dragging = false;
        var currentY = parseFloat(sheetContent.style.transform.replace(/[^0-9.-]/g, "")) || 0;
        var threshold = sheetContent.offsetHeight * 0.3;

        if (currentY > threshold) {
          sheetContent.style.transition = "transform 0.22s ease-in";
          sheetContent.style.transform = "translateY(100%)";
          if (sheetBackdrop) {
            sheetBackdrop.style.transition = "opacity 0.22s ease-in";
            sheetBackdrop.style.opacity = "0";
          }
          setTimeout(function () {
            sheetContent.style.transition = "";
            sheetContent.style.transform = "";
            if (sheetBackdrop) {
              sheetBackdrop.style.transition = "";
              sheetBackdrop.style.opacity = "";
            }
            // Close without animation since we already animated
            var sheet = document.getElementById("mobile-sheet");
            if (sheet) {
              if (sheet.classList.contains("sheet-files")) {
                var fileTree = document.getElementById("file-tree");
                var sidebarFilesPanel = document.getElementById("sidebar-panel-files");
                if (fileTree && sidebarFilesPanel) {
                  sidebarFilesPanel.appendChild(fileTree);
                }
              }
              sheet.classList.add("hidden");
              sheet.classList.remove("closing", "sheet-files");
            }
          }, 230);
        } else {
          sheetContent.style.transition = "transform 0.2s ease-out";
          sheetContent.style.transform = "translateY(0)";
          if (sheetBackdrop) {
            sheetBackdrop.style.transition = "opacity 0.2s ease-out";
            sheetBackdrop.style.opacity = "";
          }
          setTimeout(function () {
            sheetContent.style.transition = "";
            sheetContent.style.transform = "";
            if (sheetBackdrop) {
              sheetBackdrop.style.transition = "";
              sheetBackdrop.style.opacity = "";
            }
          }, 200);
        }
      }, { passive: true });
    }
  }

  // --- Mobile tab bar ---
  var mobileTabBar = document.getElementById("mobile-tab-bar");
  var mobileTabs = mobileTabBar ? mobileTabBar.querySelectorAll(".mobile-tab") : [];
  var mobileHomeBtn = document.getElementById("mobile-home-btn");

  function setMobileTabActive(tabName) {
    for (var i = 0; i < mobileTabs.length; i++) {
      if (mobileTabs[i].dataset.tab === tabName) {
        mobileTabs[i].classList.add("active");
      } else {
        mobileTabs[i].classList.remove("active");
      }
    }
    if (mobileHomeBtn) {
      if (tabName === "home") {
        mobileHomeBtn.classList.add("active");
      } else {
        mobileHomeBtn.classList.remove("active");
      }
    }
  }

  for (var t = 0; t < mobileTabs.length; t++) {
    (function (tab) {
      tab.addEventListener("click", function () {
        var name = tab.dataset.tab;

        if (name === "chat") {
          openMobileSheet("sessions");
          setMobileTabActive("chat");
        } else if (name === "search") {
          openCommandPalette();
          setMobileTabActive("search");
        } else if (name === "tools") {
          openMobileSheet("tools");
          setMobileTabActive("tools");
        } else if (name === "settings") {
          openMobileSheet("settings");
          setMobileTabActive("settings");
        }
      });
    })(mobileTabs[t]);
  }

  if (mobileHomeBtn) {
    mobileHomeBtn.addEventListener("click", function () {
      closeSidebar();
      setMobileTabActive("home");
      showHomeHub();
    });
  }
}
