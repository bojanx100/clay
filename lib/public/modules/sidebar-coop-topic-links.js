// Collapsed, keyboard-accessible expander for the project sessions related to
// one Coop topic.
//
// The panel contains links and nothing else. The server already restricted the
// list to top-level canonical project sessions the actor may see, and this
// module renders only each session's title, so no worker session, transcript,
// prompt, canonical event id, or historical attempt can surface here.
// Navigation uses the exact ProjectRef/SessionRef the server sent. Those refs
// stay in closures and are never written into DOM attributes.

import { store } from './store.js';
import { requestCanonicalSession } from './global-coop-projection.js';
import { topicRefKey } from './sidebar-coop-topic-model.js';

var EXPANDED_KEY = "expandedCoopTopicLinks";
var expanderSequence = 0;

function expansionKey(topic) {
  var projectId = topic && topic.projectRef && topic.projectRef.projectId || "";
  return topicRefKey(topic && topic.topicRef) + "@" + projectId;
}

export function isTopicLinksExpanded(topic) {
  var expanded = store.get(EXPANDED_KEY) || {};
  return !!expanded[expansionKey(topic)];
}

export function toggleTopicLinks(topic) {
  var key = expansionKey(topic);
  var expanded = Object.assign({}, store.get(EXPANDED_KEY) || {});
  if (expanded[key]) delete expanded[key];
  else expanded[key] = true;
  store.set({ expandedCoopTopicLinks: expanded });
  return !!expanded[key];
}

export function topicLinksSignature() {
  return JSON.stringify(store.get(EXPANDED_KEY) || {});
}

function relatedSessions(topic) {
  return topic && Array.isArray(topic.relatedSessions) ? topic.relatedSessions : [];
}

// The transport arrives through `options.send` rather than a direct import of
// app-connection, keeping this module independent of the connection graph.
function createLinkRow(link, prefix, options) {
  var opts = options || {};
  var row = document.createElement("button");
  row.type = "button";
  row.className = prefix + "coop-topic-link";
  row.textContent = link.title;
  row.setAttribute("aria-label", "Open project session " + link.title);
  row.addEventListener("click", function (event) {
    event.stopPropagation();
    if (typeof opts.send !== "function") return;
    // Exact ProjectRef/SessionRef routing. The refs live only in this closure.
    if (!requestCanonicalSession(link.sessionRef, opts.send)) return;
    if (typeof opts.onNavigate === "function") opts.onNavigate();
  });
  return row;
}

function createPanel(links, prefix, panelId, options) {
  var panel = document.createElement("div");
  panel.className = prefix + "coop-topic-links";
  panel.id = panelId;
  panel.setAttribute("role", "group");
  for (var i = 0; i < links.length; i++) panel.appendChild(createLinkRow(links[i], prefix, options));
  return panel;
}

// Returns the expander for a topic: a disclosure button plus its panel, wrapped
// so callers can append one node. Collapsed unless the owner expanded this exact
// topic during this session.
//
// Returns null when the topic has no ACL-visible related sessions. The same rule
// the category sections follow applies here: a control that can only ever open
// an empty panel is not rendered at all, so the compact chat list stays compact.
// Callers must treat null as "append nothing".
export function createTopicLinksExpander(topic, options) {
  var opts = options || {};
  var prefix = opts.mobile ? "mobile-" : "";
  var links = relatedSessions(topic);
  if (links.length === 0) return null;
  var expanded = isTopicLinksExpanded(topic);
  expanderSequence++;
  var panelId = prefix + "coop-topic-links-" + expanderSequence;

  var wrapper = document.createElement("div");
  wrapper.className = prefix + "coop-topic-links-wrapper";

  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = prefix + "coop-topic-links-toggle";
  toggle.id = panelId + "-toggle";
  toggle.textContent = "Related sessions (" + links.length + ")";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.setAttribute("aria-controls", panelId);
  toggle.addEventListener("click", function (event) {
    event.stopPropagation();
    toggleTopicLinks(topic);
    if (typeof opts.onToggle === "function") opts.onToggle();
  });
  wrapper.appendChild(toggle);

  // The panel is always in the DOM and hidden when collapsed. aria-controls must
  // point at an element that exists, or assistive technology cannot resolve the
  // disclosure relationship in the collapsed state. `hidden` keeps the collapsed
  // panel out of the accessibility tree and out of the tab order.
  var panel = createPanel(links, prefix, panelId, opts);
  panel.setAttribute("aria-labelledby", toggle.id);
  if (!expanded) panel.hidden = true;
  wrapper.appendChild(panel);
  return wrapper;
}
