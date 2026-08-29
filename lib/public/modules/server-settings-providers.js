// AI provider onboarding for Server Settings. The server owns discovery and
// verification; this module only renders its evidence and starts user-approved
// install/login commands in Clay's supervised terminal modal.

import { refreshIcons } from './icons.js';
import { store } from './store.js';
import { showConfirm } from './confirm-modal.js';
import { copyToClipboard, showToast } from './utils.js';
import { getWs } from './ws-ref.js';

var PROFILE_COPY = {
  economical: {
    label: "Stretch free access",
    detail: "Prefer verified free-allowance or BYOK routes; keep stronger paid routes as fallback.",
  },
  balanced: {
    label: "Balanced",
    detail: "Balance capability, health, and likely cost across every verified route.",
  },
  quality: {
    label: "Best available",
    detail: "Prefer the strongest verified route, using cheaper routes mainly for fallback.",
  },
};

var STATE_COPY = {
  ready: { label: "Ready", tone: "ready" },
  verifying: { label: "Checking", tone: "checking" },
  "login-required": { label: "Login required", tone: "warning" },
  installed: { label: "Setup incomplete", tone: "neutral" },
  error: { label: "Needs attention", tone: "danger" },
  missing: { label: "CLI missing", tone: "muted" },
  unsupported: { label: "Unavailable here", tone: "muted" },
};

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wsSend(message) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function currentSnapshot() {
  return store.get("providerHubStatus") || { providers: [], routingProfile: "balanced" };
}

function providerByVendor(vendor) {
  var providers = currentSnapshot().providers || [];
  for (var i = 0; i < providers.length; i++) {
    if (providers[i] && providers[i].vendor === vendor) return providers[i];
  }
  return null;
}

function providerStatusDetail(provider) {
  if (!provider.supported) return "This CLI cannot yet be isolated per OS user, so Clay disables it in multi-user isolation mode.";
  if (!provider.installed) return provider.installCommand
    ? "Install the CLI on this server, then connect its account."
    : "No verified installer is available for this operating system. Use the official guide.";
  if (provider.state === "verifying") return "Clay is starting the runtime and requesting its model catalog.";
  if (provider.state === "ready") {
    var count = provider.verification && provider.verification.modelCount || provider.models && provider.models.length || 0;
    return "Provider handshake passed" + (count ? " and " + count + " model" + (count === 1 ? " was" : "s were") + " discovered." : ".");
  }
  if (provider.state === "login-required") return provider.loginHint || "The CLI is installed, but its account is not usable yet.";
  if (provider.state === "error") return provider.verification && provider.verification.error || "Clay could not verify this runtime.";
  return provider.loginHint || "CLI found. Connect its account, then verify the runtime.";
}

function stepHtml(label, complete, active) {
  var className = complete ? " is-complete" : (active ? " is-current" : "");
  var icon = complete ? "check" : "circle";
  return '<li class="provider-step' + className + '"><i data-lucide="' + icon + '"></i><span>' + esc(label) + '</span></li>';
}

function readinessHtml(provider) {
  var steps = provider.steps || {};
  var current = provider.installed ? (steps.login ? (steps.models ? "ready" : "models") : "login") : "cli";
  if (!provider.supported) current = "";
  return '<ol class="provider-readiness" aria-label="Provider readiness">' +
    stepHtml("CLI", !!steps.cli, current === "cli") +
    stepHtml("Account", !!steps.login, current === "login") +
    stepHtml("Models", !!steps.models, current === "models") +
    stepHtml("Ready", !!steps.ready, current === "ready") +
    '</ol>';
}

function actionButton(action, vendor, label, icon, className, disabled) {
  return '<button type="button" class="provider-action ' + (className || "") + '" data-provider-action="' +
    esc(action) + '" data-vendor="' + esc(vendor) + '"' + (disabled ? " disabled" : "") + '><i data-lucide="' + esc(icon) + '"></i>' + esc(label) + '</button>';
}

function providerActions(provider) {
  var html = "";
  if (!provider.supported) {
    if (provider.docsUrl) html += actionButton("docs", provider.vendor, "Setup guide", "external-link");
    return html;
  }
  if (!provider.installed) {
    if (provider.installCommand) html += actionButton("install", provider.vendor, "Install CLI", "download", "provider-action-primary");
    if (provider.installCommand) html += actionButton("copy-install", provider.vendor, "Copy command", "copy");
    if (provider.docsUrl) html += actionButton("docs", provider.vendor, "Official guide", "external-link");
    return html;
  }
  if (provider.state === "verifying") {
    html += actionButton("verify", provider.vendor, "Checking…", "loader-circle", "", true);
    if (provider.docsUrl) html += actionButton("docs", provider.vendor, "Guide", "external-link");
    return html;
  }
  if (provider.state !== "ready" && provider.loginCommand) {
    html += actionButton("login", provider.vendor, "Connect account", "log-in", "provider-action-primary");
  }
  html += actionButton("verify", provider.vendor, provider.state === "ready" ? "Recheck" : "Verify", "refresh-cw");
  if (provider.loginCommand) html += actionButton("copy-login", provider.vendor, "Copy login", "copy");
  if (provider.docsUrl) html += actionButton("docs", provider.vendor, "Guide", "external-link");
  return html;
}

function modelsHtml(provider) {
  var models = provider.models || [];
  if (!models.length) return "";
  var labels = [];
  for (var i = 0; i < models.length && i < 4; i++) {
    var model = models[i];
    labels.push(typeof model === "string" ? model : model && (model.displayName || model.value || model.id || model.name) || "model");
  }
  var remaining = models.length - labels.length;
  return '<div class="provider-models"><span>Models</span><code>' + esc(labels.join(" · ")) +
    (remaining > 0 ? " · +" + remaining : "") + '</code></div>';
}

function providerCard(provider) {
  var state = STATE_COPY[provider.state] || STATE_COPY.installed;
  var possibleFree = provider.freeAllowancePotential
    ? '<span class="provider-route-note"><i data-lucide="piggy-bank"></i>Free/BYOK route possible</span>' : "";
  return '<article class="provider-card" data-provider="' + esc(provider.vendor) + '">' +
    '<div class="provider-card-top">' +
      '<img class="provider-avatar" src="' + esc(provider.avatar) + '" alt="">' +
      '<div class="provider-identity"><h3>' + esc(provider.displayName || provider.vendor) + '</h3>' +
        '<p>' + esc(provider.description) + '</p></div>' +
      '<span class="provider-state provider-state-' + esc(state.tone) + '">' + esc(state.label) + '</span>' +
    '</div>' +
    readinessHtml(provider) +
    '<div class="provider-evidence"><code>' + esc(provider.binaryName || provider.vendor) + '</code>' + possibleFree + '</div>' +
    '<p class="provider-status-detail">' + esc(providerStatusDetail(provider)) + '</p>' +
    modelsHtml(provider) +
    '<div class="provider-actions">' + providerActions(provider) + '</div>' +
    '</article>';
}

function renderSummary(snapshot) {
  var summary = document.getElementById("settings-provider-summary");
  if (!summary) return;
  var providers = snapshot.providers || [];
  var installed = 0;
  var ready = 0;
  for (var i = 0; i < providers.length; i++) {
    if (providers[i].installed) installed++;
    if (providers[i].ready) ready++;
  }
  summary.innerHTML = '<span><strong>' + ready + '</strong> ready</span>' +
    '<span><strong>' + installed + '</strong> CLIs found</span>' +
    '<span><strong>' + providers.length + '</strong> supported integrations</span>';
}

function renderProfiles(activeProfile) {
  var container = document.getElementById("settings-provider-routing");
  if (!container) return;
  var names = ["economical", "balanced", "quality"];
  var html = "";
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var copy = PROFILE_COPY[name];
    html += '<button type="button" class="provider-profile' + (name === activeProfile ? " is-active" : "") +
      '" data-provider-profile="' + name + '" aria-pressed="' + (name === activeProfile ? "true" : "false") + '">' +
      '<span>' + esc(copy.label) + '</span><small>' + esc(copy.detail) + '</small></button>';
  }
  container.innerHTML = html;
}

export function renderProviderSettings() {
  var snapshot = currentSnapshot();
  var list = document.getElementById("settings-provider-list");
  if (!list) return;
  var providers = snapshot.providers || [];
  if (!providers.length) {
    list.innerHTML = '<div class="provider-empty"><i data-lucide="loader-circle"></i><span>Reading provider setup…</span></div>';
  } else {
    var html = "";
    for (var i = 0; i < providers.length; i++) html += providerCard(providers[i]);
    list.innerHTML = html;
  }
  renderSummary(snapshot);
  renderProfiles(snapshot.routingProfile || "balanced");
  refreshIcons(document.getElementById("server-settings"));
}

export function requestProviderSettings() {
  wsSend({ type: "get_provider_status" });
  wsSend({ type: "get_project_provider_routing_profile" });
}

function beginSetup(provider, action) {
  var command = action === "install" ? provider.installCommand : provider.loginCommand;
  if (!command) return;
  var slug = store.get("currentSlug") || "";
  if (!slug) {
    showToast("Open a project before starting provider setup", "error");
    return;
  }
  store.set({
    pendingProviderSetup: {
      slug: slug,
      vendor: provider.vendor,
      displayName: provider.displayName,
      action: action,
    },
  });
  if (!wsSend({ type: "term_create", cols: 100, rows: 30, initialCommand: command + "\n" })) {
    store.set({ pendingProviderSetup: null });
    showToast("Clay is not connected", "error");
  }
}

function handleProviderAction(button) {
  var action = button.dataset.providerAction;
  var provider = providerByVendor(button.dataset.vendor);
  if (!provider) return;
  if (action === "docs") {
    if (provider.docsUrl) window.open(provider.docsUrl, "_blank", "noopener");
    return;
  }
  if (action === "copy-install" || action === "copy-login") {
    var command = action === "copy-install" ? provider.installCommand : provider.loginCommand;
    copyToClipboard(command).then(function () { showToast("Command copied"); });
    return;
  }
  if (action === "verify") {
    button.disabled = true;
    wsSend({ type: "refresh_provider", vendor: provider.vendor });
    return;
  }
  if (action === "login") {
    beginSetup(provider, "login");
    return;
  }
  if (action === "install") {
    showConfirm(
      "Run the official " + provider.displayName + " installer on this Clay server?\n\n" + provider.installCommand,
      function () { beginSetup(provider, "install"); },
      "Run installer",
      false
    );
  }
}

export function initProviderSettings() {
  var section = document.querySelector('.server-settings-section[data-section="vendors"]');
  if (!section) return;
  section.addEventListener("click", function (event) {
    var action = event.target.closest("[data-provider-action]");
    if (action) {
      handleProviderAction(action);
      return;
    }
    var profile = event.target.closest("[data-provider-profile]");
    if (profile) wsSend({ type: "set_project_provider_routing_profile", profile: profile.dataset.providerProfile });
  });
  var refresh = document.getElementById("settings-providers-refresh");
  if (refresh) {
    refresh.addEventListener("click", function () {
      refresh.disabled = true;
      if (!wsSend({ type: "refresh_vendors" })) {
        refresh.disabled = false;
        showToast("Clay is not connected", "error");
      }
    });
  }
}

export function handleProviderStatus(message) {
  store.set({ providerHubStatus: message || { providers: [], routingProfile: "balanced" } });
  var refresh = document.getElementById("settings-providers-refresh");
  var providers = message && message.providers || [];
  var verifying = false;
  for (var i = 0; i < providers.length; i++) {
    if (providers[i] && providers[i].state === "verifying") verifying = true;
  }
  if (refresh) refresh.disabled = verifying;
  renderProviderSettings();
}

export function handleProviderRoutingProfile(message) {
  var snapshot = currentSnapshot();
  if (message && message.ok === false) {
    showToast(message.error || "Could not change provider routing", "error");
    return;
  }
  var profile = message && message.profile || snapshot.routingProfile || "balanced";
  store.set({ providerHubStatus: Object.assign({}, snapshot, { routingProfile: profile }) });
  renderProfiles(profile);
}
