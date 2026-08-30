// Server-backed disclosure state for groups rendered inside the Workspace panel.

import { store } from './store.js';

var PREF_URL = "/api/user/workspace-group-states";
var PREF_KEY = "workspaceGroupStates";
var preferenceLoadStarted = false;
var preferencesReady = false;
var saveTimer = null;
var localChangeVersion = 0;

function currentStates() {
  var states = store.get(PREF_KEY);
  return states && typeof states === "object" && !Array.isArray(states) ? states : {};
}

function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 160;
}

function collapsedStates(value) {
  var next = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return next;
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i++) {
    if (validKey(keys[i]) && value[keys[i]] === true) next[keys[i]] = true;
  }
  return next;
}

function finishPreferenceLoad(value, replaceCurrent) {
  preferencesReady = true;
  store.set({ workspaceGroupStates: replaceCurrent ? collapsedStates(value) : collapsedStates(currentStates()) });
}

function saveStates() {
  saveTimer = null;
  if (typeof fetch !== "function") return;
  fetch(PREF_URL, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groups: currentStates() }),
  }).catch(function () {});
}

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStates, 250);
}

export function initWorkspaceGroupPreferences() {
  if (preferenceLoadStarted) return;
  preferenceLoadStarted = true;
  var requestVersion = localChangeVersion;
  if (typeof fetch !== "function") {
    finishPreferenceLoad(null, false);
    return;
  }
  fetch(PREF_URL, { credentials: "same-origin" })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (data) {
      finishPreferenceLoad(data && data.groups,
        !!(data && data.groups) && requestVersion === localChangeVersion);
    })
    .catch(function () { finishPreferenceLoad(null, false); });
}

export function workspaceGroupPreferencesReady() {
  return preferencesReady;
}

export function isWorkspaceGroupCollapsed(key) {
  return validKey(key) && currentStates()[key] === true;
}

export function toggleWorkspaceGroup(key) {
  if (!validKey(key)) return false;
  var next = Object.assign({}, currentStates());
  if (next[key]) delete next[key];
  else next[key] = true;
  localChangeVersion++;
  store.set({ workspaceGroupStates: next });
  queueSave();
  return next[key] === true;
}

export function workspaceGroupDomId(key) {
  var value = validKey(key) ? key : "group";
  var encoded = "";
  for (var i = 0; i < value.length; i++) encoded += value.charCodeAt(i).toString(16) + "-";
  return "workspace-group-" + encoded;
}

export function wireWorkspaceGroupControls(container) {
  if (!container) return;
  var controls = container.querySelectorAll("[data-workspace-group-toggle]");
  for (var i = 0; i < controls.length; i++) {
    controls[i].addEventListener("click", function (event) {
      if (event && typeof event.preventDefault === "function") event.preventDefault();
      toggleWorkspaceGroup(this.getAttribute("data-workspace-group-toggle"));
    });
  }
}
