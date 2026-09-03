// Shared disclosure markup for Workspace owner-ledger groups.

import { isWorkspaceGroupCollapsed, toggleWorkspaceGroup, workspaceGroupDomId } from './workspace-group-collapse.js';

function stop(event) {
  if (event && typeof event.preventDefault === "function") event.preventDefault();
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
}

function groupIndicator(key) {
  if (key === "attention" || key.indexOf("attention-project:") === 0) return "alert-circle";
  if (key === "openWork") return "list-todo";
  if (key === "working") return "activity";
  if (key === "landed") return "check-circle-2";
  if (key === "dismissed") return "minus-circle";
  if (key === "hidden") return "eye-off";
  return "circle-dot";
}

export function appendWorkspaceGroupHeading(section, key, label, count, prefix, tagName, headingClass) {
  var heading = document.createElement(tagName || "h2");
  heading.className = headingClass || prefix + "coop-owner-heading";
  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = prefix + (tagName === "h3" ? "coop-owner-project-toggle" : "coop-owner-group-toggle");
  var collapsed = isWorkspaceGroupCollapsed(key);
  var contentId = workspaceGroupDomId(key) + "-content";
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute("aria-controls", contentId);
  toggle.setAttribute("aria-label", (collapsed ? "Expand " : "Collapse ") + label + " group");
  var textNode = document.createElement("span");
  textNode.textContent = label + " (" + count + ")";
  toggle.appendChild(textNode);
  var indicator = document.createElement("i");
  indicator.className = prefix + "coop-owner-group-indicator";
  indicator.setAttribute("data-lucide", groupIndicator(key));
  indicator.setAttribute("aria-hidden", "true");
  toggle.appendChild(indicator);
  var chevron = document.createElement("i");
  chevron.className = prefix + "coop-owner-chevron";
  chevron.setAttribute("data-lucide", "chevron-down");
  chevron.setAttribute("aria-hidden", "true");
  toggle.appendChild(chevron);
  toggle.addEventListener("click", function (event) {
    stop(event);
    toggleWorkspaceGroup(key);
  });
  heading.appendChild(toggle);
  section.appendChild(heading);
  return contentId;
}

export function appendWorkspaceGroupContent(section, key, prefix, className) {
  var content = document.createElement("div");
  content.className = className || prefix + "coop-owner-section-content";
  content.id = workspaceGroupDomId(key) + "-content";
  content.hidden = isWorkspaceGroupCollapsed(key);
  section.appendChild(content);
  return content;
}
