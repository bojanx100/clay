import { iconHtml } from './icons.js';
import { sendUserAction } from './app-connection.js';
import { getCachedProjects } from './app-projects.js';

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

function channelBySlug(sessions) {
  var channels = {};
  for (var i = 0; i < sessions.length; i++) {
    var channel = sessions[i].coopChannel;
    if (channel && channel.projectSlug) channels[channel.projectSlug] = sessions[i];
  }
  return channels;
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

export function createCoopChannelsSection(options) {
  var sessions = options.sessions || [];
  var home = sessions.find(function (session) { return session.coopHome; });
  if (!home) return null;

  var section = document.createElement("div");
  section.className = "session-coop-channels";
  var header = document.createElement("div");
  header.className = "session-group-header session-coop-channels-header";
  header.innerHTML = '<span class="session-group-header-label">Coop channels</span>';
  section.appendChild(header);

  var homeDisplay = Object.assign({}, home, { sidebarTitle: "All Projects" });
  var homeRow = options.renderSessionItem(homeDisplay);
  homeRow.classList.add("session-coop-home");
  section.appendChild(homeRow);

  var channelSessions = channelBySlug(sessions);
  var projects = (getCachedProjects() || []).filter(eligibleProject);
  var children = document.createElement("div");
  children.className = "session-coop-channel-list";
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i];
    var existing = channelSessions[project.slug];
    if (options.searchMatchIds !== null && (!existing || !options.searchMatchIds.has(existing.id))) continue;
    if (!existing) {
      children.appendChild(createPendingChannelRow(project, options.onNavigate));
      continue;
    }
    var display = Object.assign({}, existing, {
      sidebarTitle: project.title || project.project || project.slug,
    });
    var row = options.renderSessionItem(display);
    row.classList.add("session-coop-channel");
    children.appendChild(row);
  }
  section.appendChild(children);
  return section;
}
