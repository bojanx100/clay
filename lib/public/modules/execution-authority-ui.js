import { store } from './store.js';

// The server resolves admitted and inherited authority. Permission preferences
// remain preferences; the browser must not infer authority from their values.
export function syncListedExecutionAuthority(msg) {
  if (msg.projectSlug && msg.projectSlug !== store.get('currentSlug')) return;
  if (store.get('activeSessionProjectSlug') !== store.get('currentSlug')) return;
  var activeId = store.get('activeSessionId');
  var active = (msg.sessions || []).find(function (session) { return session.id === activeId; });
  if (!active) return;
  store.set({ currentExecutionAuthority: active.executionAuthority === "read-only" ? "read-only" : null });
}

// Run after the ordinary config render, so returning to a normal conversation
// restores its provider controls through their existing renderers.
export function applyExecutionAuthority() {
  var readOnly = store.get('currentExecutionAuthority') === "read-only";
  var notice = document.getElementById('config-execution-authority');
  if (notice) notice.style.display = readOnly ? "" : "none";
  if (!readOnly) return;
  var detail = document.getElementById('config-execution-authority-detail');
  if (detail) detail.textContent = store.get('currentVendor') === "github-copilot"
    ? "This task requires read-only execution. Copilot cannot run it; select Claude or Codex."
    : "Can inspect local files and report findings. File edits and external actions require a separate task.";
  ["automation", "mode", "approval", "sandbox", "websearch"].forEach(function (name) {
    var section = document.getElementById('config-' + name + '-section');
    if (section) section.style.display = "none";
  });
  var label = document.getElementById('config-chip-label');
  if (label) label.textContent = (label.textContent ? label.textContent + " · " : "") + "Read-only evidence";
  var chip = document.getElementById('config-chip');
  if (chip) {
    chip.title = (chip.title ? chip.title + " · " : "") + "Read-only evidence";
    chip.setAttribute('aria-label', chip.title);
  }
}
