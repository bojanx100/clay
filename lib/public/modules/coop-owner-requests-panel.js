// coop-owner-requests-panel.js - What the owner asked for and never got.
//
// This is the highest-ranking surface in Coop, so it is drawn first and it is
// flat. The unanswered requests are their own list at the top: an audit found
// 53 owner requests that were never answered, the oldest 6.1 days old, and a
// backlog the owner has to expand a topic to discover is a backlog the owner
// will not see. The topic -> project -> coordinator -> worker tree from
// ownerRequestRows() follows underneath as orientation, not as a container.
//
// Two rules the surface must not break:
//
//   * Nothing is derived here. Every count, every state and the whole ordering
//     comes from the server's read-only overview. Deriving "still working" on
//     the client is exactly how a finished topic used to keep a spinner alive
//     after the server had already called it done, and re-counting the rows
//     would quietly disagree with a truncated list.
//   * A refusal is not an empty backlog. ok:false keeps the last known good
//     rows and says the view is stale; only a genuine zero renders "nothing
//     outstanding".
//
// Status is a dot with a tooltip, one row per request, flashing only while
// something is actively working -- the owner asked for exactly that, four
// separate times, and got text labels and extra rows instead.

import { store } from './store.js';
import { ownerRequestOverview, ownerRequestRows, unansweredRows } from './coop-owner-requests.js';
// The one canonical-event drill-through. Building the resolve message here
// would be a second mechanism to keep in step with the server's reply handling,
// which already lives in the client message router.
import { requestCanonicalEvent } from './global-coop-projection.js';

var BLOCKED_TEXT = "Blocked on you";
var WAITING_TEXT = "Waiting on Coop";

// Tooltips for the tree dots. A raw server enum is a fine class name and a poor
// thing to show the owner on hover.
var STATE_TEXT = {
  working: "Working",
  needs_input: "Needs input",
  attention: "Needs your attention",
  done: "Done",
  open: "Open",
  closed: "Closed",
};

var MINUTE = 60000;
var HOUR = 3600000;
var DAY = 86400000;

// How long the owner has been waiting, in the coarsest unit that is still
// true. Clock skew reads as "now" rather than a negative age.
export function ownerRequestAge(receivedAt, now) {
  if (typeof receivedAt !== "number" || !isFinite(receivedAt)) return "";
  var at = typeof now === "number" ? now : Date.now();
  var elapsed = at - receivedAt;
  if (!(elapsed > 0)) return "now";
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return Math.floor(elapsed / MINUTE) + "m";
  if (elapsed < DAY) return Math.floor(elapsed / HOUR) + "h";
  return Math.floor(elapsed / DAY) + "d";
}

// The server's numbers, printed verbatim. Zero-valued terms are omitted so the
// accessible name says what is true rather than reciting four zeroes.
function countPhrases(row) {
  var parts = [];
  if (row.unansweredCount) parts.push(row.unansweredCount + " unanswered");
  if (row.workingCount) parts.push(row.workingCount + " working");
  if (row.needsInputCount) parts.push(row.needsInputCount + " needs input");
  if (row.attentionCount) parts.push(row.attentionCount + " attention");
  return parts;
}

function statusDot(prefix, className, tooltip, animating) {
  var dot = document.createElement("span");
  dot.className = prefix + className;
  // The state is already in the row's accessible name; a second announcement
  // of the same fact is noise.
  dot.setAttribute("aria-hidden", "true");
  dot.setAttribute("title", tooltip);
  if (animating) dot.setAttribute("data-animating", "working");
  return dot;
}

function createUnansweredRow(row, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var blocked = !!row.blockedOnOwner;
  var status = blocked ? BLOCKED_TEXT : WAITING_TEXT;
  var age = ownerRequestAge(row.receivedAt, opts.now);

  // A real button, so Enter, Space, focus order and the focus ring come from
  // the platform instead of being re-implemented on a div.
  var el = document.createElement("button");
  el.type = "button";
  el.className = prefix + "coop-owner-request-row " +
    (blocked ? "blocked-on-owner" : "waiting-on-coop");
  el.dataset.ingressId = String(row.ingressId || "");
  el.dataset.blockedOnOwner = blocked ? "true" : "false";

  // Fails closed: a request the server gave no canonical event for cannot be
  // opened, so the row says so rather than throwing inside a handler.
  var send = typeof opts.send === "function" ? opts.send : null;
  var canOpen = !!(row.requestRef && row.topicRef && send);
  if (!canOpen) el.disabled = true;

  el.setAttribute("aria-label", [
    row.label,
    status,
    age ? age + " old" : "",
    canOpen ? "opens the request" : "no linked event",
  ].filter(Boolean).join(", "));

  el.appendChild(statusDot(prefix, "coop-owner-request-dot", status, row.state === "working"));

  var title = document.createElement("span");
  title.className = prefix + "coop-owner-request-title";
  title.textContent = row.label;
  el.appendChild(title);

  var ageEl = document.createElement("span");
  ageEl.className = prefix + "coop-owner-request-age";
  ageEl.textContent = age;
  el.appendChild(ageEl);

  el.addEventListener("click", function () {
    if (!canOpen) return;
    // The topic's own ProjectRef is resolved by the shared drill-through; the
    // overview entry carries only the canonical topic and event.
    if (requestCanonicalEvent(row.requestRef, row.topicRef, null, send) === false) return;
    if (typeof opts.onNavigate === "function") opts.onNavigate();
  });
  return el;
}

function createTreeNode(row, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var node = document.createElement("div");
  node.className = prefix + "coop-owner-request-node depth-" + row.depth + " kind-" + row.kind;
  node.dataset.kind = row.kind;
  node.dataset.depth = String(row.depth);

  var counts = row.kind === "topic" ? countPhrases(row) : [];
  node.setAttribute("aria-label", [row.label].concat(counts).filter(Boolean).join(", "));

  if (row.kind !== "project") {
    // A topic's own status is a lifecycle value ("open"); what is actually
    // running under it is the server's workingCount, so that is what decides
    // whether the topic dot flashes.
    var working = row.kind === "topic" ? row.workingCount > 0 : row.workState === "working";
    var state = row.kind === "topic" ? (working ? "working" : row.status) : row.workState;
    node.appendChild(statusDot(prefix, "coop-owner-request-node-dot " + prefix +
      "coop-owner-request-node-dot-" + String(state || "quiet").toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
      STATE_TEXT[state] || String(state || ""), working));
  }

  var label = document.createElement("span");
  label.className = prefix + "coop-owner-request-node-label";
  label.textContent = row.label;
  node.appendChild(label);

  if (counts.length) {
    var badge = document.createElement("span");
    badge.className = prefix + "coop-owner-request-node-counts";
    // Straight from the server. Never row.length, never a client tally.
    badge.textContent = String(row.unansweredCount);
    badge.setAttribute("aria-hidden", "true");
    node.appendChild(badge);
  }
  return node;
}

function appendMessage(parent, prefix, className, message) {
  var el = document.createElement("div");
  el.className = prefix + className;
  el.textContent = message;
  parent.appendChild(el);
  return el;
}

// Renders the backlog, or nothing at all before the first server answer. An
// unanswered "nothing outstanding" is a claim, and the client is not entitled
// to make it until the server has replied once.
export function renderOwnerRequestPanel(container, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var error = store.get("coopOwnerRequestsError") || null;
  var answered = !!store.get("coopOwnerRequests");
  if (!answered && !error) return 0;

  var overview = opts.overview || ownerRequestOverview();
  var counts = overview.counts || {};
  var requests = unansweredRows(overview);
  var tree = ownerRequestRows(overview);

  var section = document.createElement("section");
  section.className = prefix + "coop-owner-requests";

  var heading = document.createElement("div");
  heading.className = prefix + "coop-owner-requests-heading";
  heading.id = prefix + "coop-owner-requests-heading";
  heading.setAttribute("role", "heading");
  heading.setAttribute("aria-level", "2");
  heading.textContent = "Unanswered";
  section.setAttribute("aria-labelledby", heading.id);

  var count = document.createElement("span");
  count.className = prefix + "coop-owner-requests-count";
  // The server's total, which can exceed the rows it chose to send.
  count.textContent = String(counts.unanswered || 0);
  heading.appendChild(count);
  section.appendChild(heading);

  if (error) {
    appendMessage(section, prefix, "coop-owner-requests-stale",
      "Backlog may be out of date (" + error + ")");
  }

  // First, flat, above everything: the requests themselves.
  for (var i = 0; i < requests.length; i++) {
    section.appendChild(createUnansweredRow(requests[i], opts));
  }

  if (!requests.length && !error) {
    appendMessage(section, prefix, "coop-owner-requests-empty",
      "Nothing outstanding — every request has an answer.");
  }

  if (tree.length) {
    var treeEl = document.createElement("div");
    treeEl.className = prefix + "coop-owner-requests-tree";
    for (var t = 0; t < tree.length; t++) treeEl.appendChild(createTreeNode(tree[t], opts));
    section.appendChild(treeEl);
  }

  container.appendChild(section);
  return requests.length;
}

// The panel is not part of the cloned projection, so the session-list signature
// cannot see it. Without this term a request being answered would change the
// backlog while leaving the sidebar signature identical, and the repaint would
// be suppressed. Only the rendered fields contribute.
export function ownerRequestPanelSignature() {
  var overview = ownerRequestOverview();
  var counts = overview.counts || {};
  var parts = [String(store.get("coopOwnerRequestsError") || ""), String(counts.unanswered || 0)];
  var requests = unansweredRows(overview);
  for (var i = 0; i < requests.length; i++) {
    parts.push([requests[i].ingressId, requests[i].state, requests[i].label].join("~"));
  }
  var tree = ownerRequestRows(overview);
  for (var t = 0; t < tree.length; t++) {
    parts.push([tree[t].kind, tree[t].label, tree[t].workState || tree[t].status || "",
      tree[t].unansweredCount || 0].join("~"));
  }
  return parts.join(";");
}
