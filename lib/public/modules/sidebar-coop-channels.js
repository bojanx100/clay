import { iconHtml } from './icons.js';
import { sendUserAction } from './app-connection.js';
import { getCachedProjects } from './app-projects.js';

var metadataRefreshRequested = false;

function eligibleProject(project) {
  return project && !project.isLead && !project.isMate && !project.isWorktree;
}

export function coopConversation(session) {
  return !!(session && (session.coopHome || session.coopChannel));
}

export function regularCoopSessions(sessions) {
  return (sessions || []).filter(function (session) { return !coopConversation(session); });
}

export function coopProjectSignature() {
  return JSON.stringify((getCachedProjects() || []).filter(eligibleProject).map(function (project) {
    return [project.slug, project.title || project.project || "", project.path || ""];
  }));
}

export function waitForCoopSessionMetadata(sessions, currentSlug) {
  if (currentSlug !== "lead") {
    metadataRefreshRequested = false;
    return false;
  }
  var hasHome = (sessions || []).some(function (session) { return session.coopHome; });
  if (hasHome) {
    metadataRefreshRequested = false;
    return false;
  }
  if (!metadataRefreshRequested) {
    metadataRefreshRequested = sendUserAction({ type: "refresh_coop_channels" });
  }
  return metadataRefreshRequested;
}

function channelBySlug(sessions) {
  var channels = {};
  for (var i = 0; i < sessions.length; i++) {
    var channel = sessions[i].coopChannel;
    if (channel && channel.projectSlug) channels[channel.projectSlug] = sessions[i];
  }
  return channels;
}

function matchesProjectSearch(project, query) {
  if (!query) return true;
  var label = project.title || project.project || project.slug || "";
  return String(label).toLowerCase().indexOf(query) !== -1;
}

function createPendingChannelRow(project, onNavigate) {
  var row = document.createElement("div");
  row.className = "session-item session-coop-channel pending";
  row.dataset.coopProjectSlug = project.slug;
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  var text = document.createElement("span");
  text.className = "session-item-text";
  text.innerHTML = iconHtml("folder");
  var title = document.createElement("span");
  title.className = "session-item-title";
  title.textContent = project.title || project.project || project.slug;
  text.appendChild(title);
  row.appendChild(text);
  function openChannel() {
    if (sendUserAction({ type: "ensure_coop_channel", projectSlug: project.slug }) && onNavigate) {
      onNavigate();
    }
  }
  row.addEventListener("click", openChannel);
  row.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openChannel();
  });
  return row;
}

function homeMatchesSearch(home, query, matchIds) {
  return !query || "all projects".indexOf(query) !== -1 ||
    (matchIds !== null && matchIds.has(home.id));
}

function appendHomeRow(section, home, options) {
  var homeDisplay = Object.assign({}, home, { sidebarTitle: "All Projects" });
  var homeRow = options.renderSessionItem(homeDisplay);
  homeRow.classList.add("session-coop-home");
  section.appendChild(homeRow);
}

function projectVisible(project, existing, query, matchIds) {
  var sessionMatches = existing && matchIds !== null && matchIds.has(existing.id);
  if (query) return matchesProjectSearch(project, query) || !!sessionMatches;
  return matchIds === null || !!sessionMatches;
}

function appendProjectRow(children, project, existing, options) {
  if (!existing) {
    children.appendChild(createPendingChannelRow(project, options.onNavigate));
    return;
  }
  var display = Object.assign({}, existing, {
    sidebarTitle: project.title || project.project || project.slug,
  });
  var row = options.renderSessionItem(display);
  row.classList.add("session-coop-channel");
  children.appendChild(row);
}

function appendProjectRows(section, sessions, query, matchIds, options) {
  var channelSessions = channelBySlug(sessions);
  var projects = (getCachedProjects() || []).filter(eligibleProject);
  var children = document.createElement("div");
  var visibleRows = 0;
  children.className = "session-coop-channel-list";
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i];
    var existing = channelSessions[project.slug];
    if (!projectVisible(project, existing, query, matchIds)) continue;
    appendProjectRow(children, project, existing, options);
    visibleRows++;
  }
  section.appendChild(children);
  return visibleRows;
}

export function createCoopChannelsSection(options) {
  var sessions = options.sessions || [];
  var home = sessions.find(function (session) { return session.coopHome; });
  if (!home) return null;
  var query = String(options.searchQuery || "").trim().toLowerCase();
  var matchIds = options.searchMatchIds;

  var section = document.createElement("div");
  section.className = "session-coop-channels";
  var header = document.createElement("div");
  header.className = "session-group-header session-coop-channels-header";
  header.innerHTML = '<span class="session-group-header-label">Coop channels</span>';
  section.appendChild(header);

  var visibleRows = 0;
  if (homeMatchesSearch(home, query, matchIds)) {
    appendHomeRow(section, home, options);
    visibleRows++;
  }
  visibleRows += appendProjectRows(section, sessions, query, matchIds, options);
  return visibleRows > 0 ? section : null;
}
