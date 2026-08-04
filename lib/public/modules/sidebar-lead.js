// sidebar-lead.js - Lead pseudo-project sidebar rows

import { parseEmojis } from './markdown.js';

export function isLeadProject(project) {
  return !!(project && (project.isLead || project.slug === "lead"));
}

export function findLeadProject(projects) {
  for (var i = 0; i < projects.length; i++) {
    if (isLeadProject(projects[i])) return projects[i];
  }
  return null;
}

export function filterLeadProjects(projects) {
  var filtered = [];
  for (var i = 0; i < projects.length; i++) {
    if (!isLeadProject(projects[i])) filtered.push(projects[i]);
  }
  return filtered;
}

function getLeadLabel(project) {
  return (project && (project.name || project.title || project.project)) || "Lead";
}

function appendLeadIcon(row, project, iconClassName) {
  var icon = document.createElement("span");
  icon.className = iconClassName;
  icon.textContent = (project && project.icon) || "🧭";
  parseEmojis(icon);
  row.appendChild(icon);
}

function appendLeadBadge(row, badgeClassName) {
  var badge = document.createElement("span");
  badge.className = badgeClassName;
  badge.textContent = "Lead";
  row.appendChild(badge);
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
  appendLeadBadge(row, "project-list-lead-badge");

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
  appendLeadBadge(row, "mobile-lead-project-badge");

  row.addEventListener("click", function () {
    onSelect(project.slug);
  });

  return row;
}
