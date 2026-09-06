// sidebar-lead.js - Lead pseudo-project sidebar rows

import { parseEmojis } from './markdown.js';
import { COOP_IDENTITY } from './coop-identity.js';
import { store } from './store.js';

export function isLeadProject(project) {
  return !!(project && (project.isLead || project.slug === "lead"));
}

export function findLeadProject(projects) {
  for (var i = 0; i < projects.length; i++) {
    if (isLeadProject(projects[i])) return projects[i];
  }
  return null;
}

// Keep saved Coop history registered, but expose its workspace in project
// navigation only after the server confirms that Lead mode is enabled.
export function findVisibleLeadProject(projects) {
  return store.get('leadModeEnabled') === true ? findLeadProject(projects) : null;
}

export function filterLeadProjects(projects) {
  var filtered = [];
  for (var i = 0; i < projects.length; i++) {
    if (!isLeadProject(projects[i])) filtered.push(projects[i]);
  }
  return filtered;
}

// "Lead" is Coop's internal power mode, never a name the owner should see. The
// fallback used to be the literal string, so stale or missing metadata rendered
// the internal identity straight into the sidebar.
function getLeadLabel(project) {
  return (project && (project.name || project.title || project.project)) || COOP_IDENTITY;
}

function appendLeadIcon(row, project, iconClassName) {
  var icon = document.createElement("span");
  icon.className = iconClassName;
  icon.textContent = (project && project.icon) || "🧭";
  parseEmojis(icon);
  row.appendChild(icon);
}

// The badge is gone entirely rather than relabelled: the row already says
// "Coop", so a second chip repeating the identity adds nothing, and the only
// text it ever carried was the internal mode name.

export function decorateMobileLeadChatChip(chip, project) {
  if (!chip || !isLeadProject(project)) return chip;
  chip.classList.add("lead-chip");
  return chip;
}

function appendDesktopUnread(row, project, currentSlug) {
  if (!project || project.unread <= 0 || project.slug === currentSlug) return;
  var unread = document.createElement("span");
  unread.className = "pd-count";
  unread.textContent = project.unread > 99 ? "99+" : String(project.unread);
  row.appendChild(unread);
}

function appendMobileUnread(row, project, currentSlug) {
  if (!project || project.unread <= 0 || project.slug === currentSlug) return;
  var unread = document.createElement("span");
  unread.className = "mobile-project-unread";
  unread.textContent = project.unread > 99 ? "99+" : String(project.unread);
  row.appendChild(unread);
}

export function createDesktopLeadProjectItem(project, currentSlug, onSelect) {
  var row = document.createElement("button");
  row.className = "project-list-item project-list-lead-item" + (project.slug === currentSlug ? " current" : "");
  row.type = "button";
  row.dataset.slug = project.slug;

  appendLeadIcon(row, project, "project-list-lead-icon");

  var name = document.createElement("span");
  name.className = "pd-name";
  name.textContent = getLeadLabel(project);
  row.appendChild(name);

  appendDesktopUnread(row, project, currentSlug);

  row.addEventListener("click", function () {
    onSelect(project.slug);
  });

  return row;
}

export function createMobileLeadProjectItem(project, currentSlug, onSelect) {
  var row = document.createElement("button");
  row.className = "mobile-project-item mobile-lead-project-item" + (project.slug === currentSlug ? " active" : "");
  row.type = "button";
  row.dataset.slug = project.slug;

  appendLeadIcon(row, project, "mobile-project-abbrev mobile-lead-project-icon");

  var name = document.createElement("span");
  name.className = "mobile-project-name";
  name.textContent = getLeadLabel(project);
  row.appendChild(name);

  appendMobileUnread(row, project, currentSlug);

  row.addEventListener("click", function () {
    onSelect(project.slug);
  });

  return row;
}
