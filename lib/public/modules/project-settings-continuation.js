import { sendUserAction } from './app-connection.js';
import { showToast } from './utils.js';

export function initProjectContinuationSetting() {
  var toggle = document.getElementById("ps-auto-continue-comparable");
  if (!toggle) return;
  toggle.addEventListener("change", function () {
    var slug = toggle.dataset.projectSlug || "";
    if (!slug) return;
    var status = document.getElementById("ps-auto-continue-comparable-status");
    toggle.disabled = true;
    if (status) status.textContent = "Saving...";
    if (!sendUserAction({
      type: "set_project_auto_continue_comparable",
      slug: slug,
      enabled: toggle.checked,
    })) {
      toggle.disabled = false;
      if (status) status.textContent = "Not connected";
    }
  });
}

export function loadProjectContinuationSetting(slug) {
  var toggle = document.getElementById("ps-auto-continue-comparable");
  var status = document.getElementById("ps-auto-continue-comparable-status");
  if (toggle) {
    toggle.dataset.projectSlug = slug || "";
    toggle.disabled = true;
  }
  if (status) status.textContent = "Loading...";
  if (slug) {
    sendUserAction({ type: "get_project_auto_continue_comparable", slug: slug });
  }
}

export function handleProjectContinuationSetting(msg) {
  var toggle = document.getElementById("ps-auto-continue-comparable");
  if (toggle && msg.slug && toggle.dataset.projectSlug && msg.slug !== toggle.dataset.projectSlug) return;
  var status = document.getElementById("ps-auto-continue-comparable-status");
  if (toggle) {
    toggle.checked = msg.enabled !== false;
    toggle.disabled = false;
  }
  if (status) status.textContent = "";
}

export function handleSetProjectContinuationResult(msg) {
  var toggle = document.getElementById("ps-auto-continue-comparable");
  if (toggle && msg.slug && toggle.dataset.projectSlug && msg.slug !== toggle.dataset.projectSlug) return;
  var status = document.getElementById("ps-auto-continue-comparable-status");
  if (toggle) {
    toggle.checked = msg.enabled !== false;
    toggle.disabled = false;
  }
  if (msg.ok) {
    if (status) status.textContent = "Saved";
  } else {
    if (status) status.textContent = msg.error ? "Error: " + msg.error : "Error";
    showToast(msg.error || "Failed to save auto-continue policy", "error");
  }
  setTimeout(function () {
    if (status) status.textContent = "";
  }, 2500);
}
