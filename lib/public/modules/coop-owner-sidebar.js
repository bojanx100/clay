// Shared desktop/mobile renderer for the durable Coop owner work ledger.

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
  var topic = findGlobalCoopTopic(entry.topicRef, null);
  if (!topic || !requestCoopTopic(topic, options.send)) return false;
  if (typeof options.onNavigate === "function") options.onNavigate();
  return true;
}

function openSession(sessionRef, options) {
  if (!sessionRef || !requestCanonicalSession(sessionRef, options.send)) return false;
  if (typeof options.onNavigate === "function") options.onNavigate();
  return true;
}

function roleLabel(session) {
  var role = text(session && session.role, "session").replace(/_/g, " ");
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function appendDestinations(row, entry, options, prefix) {
  var destinations = document.createElement("div");
  destinations.className = prefix + "coop-owner-links";
  if (entry.topicRef) {
    appendButton(destinations, prefix + "coop-owner-link", "Thread", function () {
      openThread(entry, options);
    }, "Open the canonical Thread");
  }
  var sessions = Array.isArray(entry.sessions) ? entry.sessions : [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    if (!session.sessionRef) continue;
    appendButton(destinations, prefix + "coop-owner-link", roleLabel(session), (function (ref) {
      return function () { openSession(ref, options); };
    }(session.sessionRef)), "Open " + text(session.title, "the related session"));
  }
  if (destinations.children.length > 0) row.appendChild(destinations);
}

function appendVisibilityControl(row, entry, sidebar, options, prefix) {
  if (!entry.hidden && entry.clearable !== true) return;
  var controls = document.createElement("div");
  controls.className = prefix + "coop-owner-visibility";
  var hiding = !entry.hidden;
  appendButton(controls, prefix + "coop-owner-visibility-button", hiding ? "Clear" : "Restore", function () {
    options.send({
      type: "coop_owner_ledger_visibility",
      entryId: entry.entryId,
      hidden: hiding,
      expectedRevision: sidebar.revision,
    });
  }, hiding ? "Move this completed or dismissed entry to Hidden" :
    "Restore this entry to the open ledger");
  row.appendChild(controls);
}

function createRow(entry, sidebar, options) {
  var prefix = options.mobile ? "mobile-" : "";
  var row = document.createElement("article");
  row.className = prefix + "coop-owner-row " + prefix + "coop-owner-row-" +
    classToken(entry.status, "planned");
  var title = document.createElement("button");
  title.type = "button";
  title.className = prefix + "coop-owner-title";
  title.textContent = text(entry.title, "Owner request");
  title.setAttribute("aria-label", text(entry.title, "Owner request") + ", open canonical Thread");
  title.addEventListener("click", function (event) {
    stop(event);
    openThread(entry, options);
  });
  row.appendChild(title);

  var meta = document.createElement("div");
  meta.className = prefix + "coop-owner-meta";
  var status = document.createElement("span");
  status.className = prefix + "coop-owner-status " + prefix + "coop-owner-status-" +
    classToken(entry.status, "planned");
  status.textContent = text(entry.status, "planned").replace(/_/g, " ");
  meta.appendChild(status);
  row.appendChild(meta);

  var reason = text(entry.reason, "");
  if (reason) {
    var copy = document.createElement("p");
    copy.className = prefix + "coop-owner-reason";
    copy.textContent = reason;
    row.appendChild(copy);
  }
  appendDestinations(row, entry, options, prefix);
  appendVisibilityControl(row, entry, sidebar, options, prefix);
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
  for (var i = 0; i < list.length; i++) section.appendChild(createRow(list[i], sidebar, options));
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
  rendered += appendSection(surface, "open", "Open", sidebar.open, sidebar, opts);
  rendered += appendSection(surface, "hidden", "Hidden", sidebar.hidden, sidebar, opts);
  if (rendered > 0) container.appendChild(surface);
  return rendered;
}
