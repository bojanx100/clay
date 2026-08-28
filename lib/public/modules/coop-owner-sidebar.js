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

function detailFor(entry, options) {
  var details = options.details && typeof options.details === "object" ? options.details : {};
  return details[entry.entryId] || null;
}

function changeDetail(entry, options, value) {
  var next = Object.assign({}, options.details || {});
  next[entry.entryId] = value;
  options.details = next;
  if (typeof options.onDetailsChange === "function") options.onDetailsChange(next);
}

function toggleDetail(entry, options) {
  var current = detailFor(entry, options);
  if (current && current.expanded) {
    changeDetail(entry, options, Object.assign({}, current, { expanded: false }));
    return true;
  }
  var next = Object.assign({}, current || {}, { expanded: true });
  if (!next.state) next.state = "loading";
  changeDetail(entry, options, next);
  if (current && current.state === "ready") return true;
  if (current && current.state === "loading") return true;
  if (options.send({ type: "coop_owner_ledger_detail", entryId: entry.entryId }) === false) {
    changeDetail(entry, options, { expanded: true, state: "error", code: "connection_unavailable" });
  }
  return true;
}

function appendLifecycle(detailNode, detail, prefix) {
  var history = Array.isArray(detail && detail.history) ? detail.history : [];
  if (history.length === 0) return;
  var list = document.createElement("ul");
  list.className = prefix + "coop-owner-detail-history";
  for (var i = 0; i < history.length; i++) {
    var item = document.createElement("li");
    item.textContent = text(history[i] && history[i].label, "Status updated");
    if (history[i] && history[i].summary) item.textContent += " — " + history[i].summary;
    list.appendChild(item);
  }
  detailNode.appendChild(list);
}

function appendDetail(row, entry, options, prefix) {
  var state = detailFor(entry, options);
  if (!state || !state.expanded) return;
  var panel = document.createElement("section");
  panel.className = prefix + "coop-owner-detail";
  panel.setAttribute("aria-live", "polite");
  if (state.state === "loading") {
    panel.textContent = "Loading the original owner message…";
    row.appendChild(panel);
    return;
  }
  if (state.state !== "ready" || !state.detail) {
    panel.textContent = "The original message is unavailable. The status and source references above remain authoritative.";
    row.appendChild(panel);
    return;
  }
  var detail = state.detail;
  var label = document.createElement("div");
  label.className = prefix + "coop-owner-detail-label";
  label.textContent = "Original owner message";
  panel.appendChild(label);
  var message = document.createElement("p");
  message.className = prefix + "coop-owner-detail-message";
  message.textContent = text(detail.originalMessage, "Message unavailable");
  panel.appendChild(message);
  if (detail.truncated) {
    var truncation = document.createElement("p");
    truncation.className = prefix + "coop-owner-detail-note";
    truncation.textContent = "Long message truncated here; open the source session for the complete turn.";
    panel.appendChild(truncation);
  }
  appendLifecycle(panel, detail, prefix);
  var provenance = document.createElement("div");
  provenance.className = prefix + "coop-owner-detail-provenance";
  var requestRef = detail.requestRef || {};
  provenance.textContent = "Ingress " + text(detail.ingressId, entry.entryId) +
    (Number.isInteger(requestRef.eventIndex) ? " · message #" + requestRef.eventIndex : "");
  panel.appendChild(provenance);
  if (detail.sourceSessionRef) {
    appendButton(panel, prefix + "coop-owner-link", "Open source session", function () {
      openSession(detail.sourceSessionRef, options);
    }, "Open the session containing the original owner message");
  }
  row.appendChild(panel);
}

export function applyCoopOwnerLedgerDetailResult(current, message) {
  if (!message || message.type !== "coop_owner_ledger_detail_result" || !message.entryId) return current || {};
  var next = Object.assign({}, current || {});
  var previous = next[message.entryId] || {};
  next[message.entryId] = message.ok && message.detail
    ? { expanded: previous.expanded !== false, state: "ready", detail: message.detail }
    : { expanded: previous.expanded !== false, state: "error", code: message.code || "message_unavailable" };
  return next;
}

function appendDestinations(row, entry, options, prefix) {
  var destinations = document.createElement("div");
  destinations.className = prefix + "coop-owner-links";
  if (entry.topicRef) {
    appendButton(destinations, prefix + "coop-owner-link", "Thread", function () {
      openThread(entry, options);
    }, "Open the canonical Thread");
  }
  if (entry.sourceSessionRef) {
    appendButton(destinations, prefix + "coop-owner-link", "Original request", function () {
      openSession(entry.sourceSessionRef, options);
    }, "Open the source session containing the original owner request");
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

function appendContext(row, entry, prefix) {
  var projects = Array.isArray(entry.projects) ? entry.projects : [];
  var provenance = entry && entry.ingressId ? "Ingress " + entry.ingressId : "";
  var labels = [];
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i] || {};
    var label = text(project.title, "");
    if (label && labels.indexOf(label) === -1) labels.push(label);
  }
  if (labels.length || provenance) {
    var context = document.createElement("p");
    context.className = prefix + "coop-owner-context";
    context.textContent = labels.join(" · ") + (labels.length && provenance ? " · " : "") + provenance;
    row.appendChild(context);
  }
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
  var detail = detailFor(entry, options);
  title.setAttribute("aria-expanded", detail && detail.expanded ? "true" : "false");
  title.setAttribute("aria-label", text(entry.title, "Owner request") +
    (entry.topicRef ? ", open canonical Thread or show message details" : ", show message details"));
  title.addEventListener("click", function (event) {
    stop(event);
    if (!openThread(entry, options)) toggleDetail(entry, options);
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
  appendContext(row, entry, prefix);
  appendDetail(row, entry, options, prefix);
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
