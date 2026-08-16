// Shared desktop/mobile renderer for Coop's owner control surface.

import {
  findGlobalCoopTopic,
  requestCanonicalSession,
  requestCoopTopic,
} from './global-coop-projection.js';

function text(value, fallback) {
  var result = typeof value === "string" ? value.trim() : "";
  return result || fallback || "";
}

function classToken(value, fallback) {
  return text(value, fallback).toLowerCase().replace(/[^a-z0-9_]+/g, "-");
}

function stop(event) {
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
}

function appendButton(container, className, label, onClick, title) {
  var button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  if (title) button.title = title;
  button.addEventListener("click", function (event) {
    stop(event);
    onClick();
  });
  container.appendChild(button);
  return button;
}

function openThread(entry, options) {
  var topic = findGlobalCoopTopic(entry.topicRef, entry.projectRef);
  if (!topic || !requestCoopTopic(topic, options.send)) return false;
  if (typeof options.onNavigate === "function") options.onNavigate();
  return true;
}

function openSession(sessionRef, options) {
  if (!sessionRef || !requestCanonicalSession(sessionRef, options.send)) return false;
  if (typeof options.onNavigate === "function") options.onNavigate();
  return true;
}

function appendDestinations(row, entry, options, prefix) {
  var destinations = document.createElement("div");
  destinations.className = prefix + "coop-owner-links";
  if (entry.topicRef) {
    appendButton(destinations, prefix + "coop-owner-link", "Thread", function () {
      openThread(entry, options);
    }, "Open the canonical Thread");
  }
  if (entry.coordinator && entry.coordinator.sessionRef) {
    appendButton(destinations, prefix + "coop-owner-link", "Coordinator", function () {
      openSession(entry.coordinator.sessionRef, options);
    }, "Open " + text(entry.coordinator.title, "the project coordinator"));
  }
  var sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    if (!session.sessionRef) continue;
    appendButton(destinations, prefix + "coop-owner-link", "Session", (function (ref) {
      return function () { openSession(ref, options); };
    }(session.sessionRef)), "Open " + text(session.title, "the related session"));
  }
  if (destinations.children.length > 0) row.appendChild(destinations);
}

function appendPriorityControls(row, entry, index, total, revision, options, prefix) {
  var controls = document.createElement("div");
  controls.className = prefix + "coop-owner-priority";
  controls.setAttribute("aria-label", "Change priority for " + text(entry.title, "this Thread"));
  var earlier = appendButton(controls, prefix + "coop-owner-priority-button", "Earlier", function () {
    options.send({
      type: "coop_owner_sidebar_prioritize", topicRef: entry.topicRef,
      direction: "earlier", expectedRevision: revision,
    });
  }, "Move earlier in Next");
  earlier.disabled = index === 0;
  var later = appendButton(controls, prefix + "coop-owner-priority-button", "Later", function () {
    options.send({
      type: "coop_owner_sidebar_prioritize", topicRef: entry.topicRef,
      direction: "later", expectedRevision: revision,
    });
  }, "Move later in Next");
  later.disabled = index === total - 1;
  row.appendChild(controls);
}

function createRow(entry, section, index, total, sidebar, options) {
  var prefix = options.mobile ? "mobile-" : "";
  var row = document.createElement("article");
  row.className = prefix + "coop-owner-row " + prefix + "coop-owner-row-" +
    classToken(entry.status, "quiet");
  var title = document.createElement("button");
  title.type = "button";
  title.className = prefix + "coop-owner-title";
  title.textContent = text(entry.title, "Untitled Thread");
  title.setAttribute("aria-label", text(entry.title, "Untitled Thread") + ", open canonical Thread");
  title.addEventListener("click", function (event) {
    stop(event);
    openThread(entry, options);
  });
  row.appendChild(title);

  var meta = document.createElement("div");
  meta.className = prefix + "coop-owner-meta";
  var status = document.createElement("span");
  status.className = prefix + "coop-owner-status " + prefix + "coop-owner-status-" +
    classToken(entry.status, "quiet");
  status.textContent = text(entry.status, "quiet").replace(/_/g, " ");
  meta.appendChild(status);
  if (entry.projectTitle) {
    var project = document.createElement("span");
    project.className = prefix + "coop-owner-project";
    project.textContent = entry.projectTitle;
    meta.appendChild(project);
  }
  row.appendChild(meta);

  var reason = text(entry.reason, entry.activity);
  if (reason) {
    var copy = document.createElement("p");
    copy.className = prefix + "coop-owner-reason";
    copy.textContent = reason;
    row.appendChild(copy);
  }
  if (entry.unblockAction && entry.unblockAction !== reason) {
    var action = document.createElement("p");
    action.className = prefix + "coop-owner-unblock";
    action.textContent = "To unblock: " + entry.unblockAction;
    row.appendChild(action);
  }
  if (entry.evidence) {
    var evidence = document.createElement("p");
    evidence.className = prefix + "coop-owner-evidence";
    evidence.textContent = entry.evidence;
    row.appendChild(evidence);
  }
  appendDestinations(row, entry, options, prefix);
  if (section === "next") {
    appendPriorityControls(row, entry, index, total, sidebar.priorityRevision, options, prefix);
  }
  return row;
}

function appendSection(container, key, label, entries, sidebar, options) {
  var list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return 0;
  var prefix = options.mobile ? "mobile-" : "";
  var section = document.createElement("section");
  section.className = prefix + "coop-owner-section " + prefix + "coop-owner-section-" + key;
  var heading = document.createElement("h2");
  heading.className = prefix + "coop-owner-heading";
  heading.textContent = label;
  section.appendChild(heading);
  for (var i = 0; i < list.length; i++) {
    section.appendChild(createRow(list[i], key, i, list.length, sidebar, options));
  }
  container.appendChild(section);
  return list.length;
}

export function renderCoopOwnerSidebar(container, sidebar, options) {
  var opts = Object.assign({ send: function () { return false; } }, options || {});
  if (!sidebar || typeof sidebar !== "object") return 0;
  var prefix = opts.mobile ? "mobile-" : "";
  var surface = document.createElement("div");
  surface.className = prefix + "coop-owner-sidebar";
  var rendered = 0;
  rendered += appendSection(surface, "now", "Now", sidebar.now, sidebar, opts);
  rendered += appendSection(surface, "next", "Next", sidebar.next, sidebar, opts);
  rendered += appendSection(surface, "needs-you", "Needs you", sidebar.needsYou, sidebar, opts);
  rendered += appendSection(surface, "blocked", "Blocked", sidebar.blocked, sidebar, opts);
  rendered += appendSection(surface, "recent", "Recently completed", sidebar.recentlyCompleted, sidebar, opts);
  if (rendered > 0) container.appendChild(surface);
  return rendered;
}
