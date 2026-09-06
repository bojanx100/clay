import { store } from './store.js';
import { showToast } from './utils.js';
import { refreshIcons } from './icons.js';
import { updateStatusPanel, handleAutoApprovalState } from './app-panels.js';
import { handleProjectOwnerChanged, handleGitAccountsList, handleProjectGitAccount, handleSetProjectGitAccountResult } from './project-settings.js';
import { handleProjectContinuationSetting, handleSetProjectContinuationResult } from './project-settings-continuation.js';
import { handleTaskSetupState, handleTaskSetupAccounts, handleTaskSetupRepos, handleTaskSetupBoards, handleTaskSetupResult } from './project-task-wizard.js';
import { updateSettingsStats, updateDaemonConfig, handleSetPinResult, handleLeadModeState, handleKeepAwakeChanged, handleInheritGroupsChanged, handleAutoContinueChanged, handleRestartResult, handleShutdownResult } from './server-settings.js';
import { handleSharedLeadModeState } from './user-settings.js';
import { checkAdminAccess } from './admin.js';
import { updateProjectList, showUpdateAvailable, handleRemoveProjectCheckResult, handleRemoveProjectResult, handleBrowseDirResult, handleAddProjectResult, handleCloneProgress } from './app-projects.js';
import { renderUserStrip } from './sidebar-mates.js';
import { handleWhatsNewState, handleWhatsNewSeenResult, setKnownEntries as setWhatsNewKnownEntries } from './whats-new.js';
import { setAutoLaunchActivity } from './sidebar-sessions.js';
import { handleProviderRoutingProfile, handleProviderStatus } from './server-settings-providers.js';

var connectOverlay = document.getElementById("connect-overlay");

export function handleSettingsMessage(msg) {
  switch (msg.type) {
    case "update_available":
      if (store.get('isMultiUserMode')) {
        checkAdminAccess().then(function (isAdmin) {
          if (!isAdmin) return;
          showUpdateAvailable(msg);
        });
      } else {
        showUpdateAvailable(msg);
      }
      return true;
    case "up_to_date":
      handleUpToDate(msg);
      return true;
    case "update_started":
      handleUpdateStarted();
      return true;
    case "remove_project_check_result":
      handleRemoveProjectCheckResult(msg);
      return true;
    case "process_stats":
      updateStatusPanel(msg);
      updateSettingsStats(msg);
      return true;
    case "browse_dir_result":
      handleBrowseDirResult(msg);
      return true;
    case "add_project_result":
      handleAddProjectResult(msg);
      return true;
    case "clone_project_progress":
      handleCloneProgress(msg);
      return true;
    case "remove_project_result":
      handleRemoveProjectResult(msg);
      return true;
    case "reorder_projects_result":
      if (!msg.ok) {
        showToast(msg.error || "Failed to reorder projects", "error");
      }
      return true;
    case "set_project_title_result":
      if (!msg.ok) {
        showToast(msg.error || "Failed to rename project", "error");
      }
      return true;
    case "set_project_icon_result":
      if (!msg.ok) {
        showToast(msg.error || "Failed to set icon", "error");
      }
      return true;
    case "git_accounts_list":
      handleGitAccountsList(msg);
      return true;
    case "project_git_account":
      handleProjectGitAccount(msg);
      return true;
    case "set_project_git_account_result":
      handleSetProjectGitAccountResult(msg);
      if (!msg.ok) {
        showToast(msg.error || "Failed to set GitHub account", "error");
      }
      return true;
    case "project_auto_continue_comparable":
      handleProjectContinuationSetting(msg);
      return true;
    case "set_project_auto_continue_comparable_result":
      handleSetProjectContinuationResult(msg);
      return true;
    case "provider_status":
      handleProviderStatus(msg);
      return true;
    case "project_provider_routing_profile":
    case "set_project_provider_routing_profile_result":
      handleProviderRoutingProfile(msg);
      return true;
    case "projects_updated":
      updateProjectList(msg);
      renderUserStrip();
      return true;
    case "project_owner_changed":
      store.set({ currentProjectOwnerId: msg.ownerId });
      handleProjectOwnerChanged(msg);
      return true;
    case "daemon_config":
      if (msg.config && msg.config.headless) store.set({ isHeadlessMode: true });
      updateDaemonConfig(msg.config);
      return true;
    case "set_pin_result":
      handleSetPinResult(msg);
      return true;
    case "set_lead_mode_result":
    case "lead_mode_changed":
      handleLeadModeState(msg);
      handleSharedLeadModeState(msg);
      return true;
    case "set_keep_awake_result":
    case "keep_awake_changed":
      handleKeepAwakeChanged(msg);
      return true;
    case "set_inherit_groups_result":
    case "inherit_groups_changed":
      handleInheritGroupsChanged(msg);
      return true;
    case "set_auto_continue_result":
    case "auto_continue_changed":
      handleAutoContinueChanged(msg);
      return true;
    case "whats_new_state":
      if (msg && Array.isArray(msg.entries)) setWhatsNewKnownEntries(msg.entries);
      handleWhatsNewState(msg);
      return true;
    case "whats_new_seen_result":
      handleWhatsNewSeenResult(msg);
      return true;
    case "set_claude_open_mode_result":
    case "claude_open_mode_changed":
      handleClaudeOpenMode(msg);
      return true;
    case "auto_launch_state":
      handleAutoLaunchState(msg);
      return true;
    case "auto_launch_activity":
      setAutoLaunchActivity(msg);
      return true;
    case "auto_approval_state":
      handleAutoApprovalState(msg);
      return true;
    case "task_setup_state":
      handleTaskSetupState(msg);
      return true;
    case "task_setup_accounts":
      handleTaskSetupAccounts(msg);
      return true;
    case "task_setup_repos":
      handleTaskSetupRepos(msg);
      return true;
    case "task_setup_boards":
      handleTaskSetupBoards(msg);
      return true;
    case "task_setup_result":
      handleTaskSetupResult(msg);
      return true;
    case "claude_allow_list":
      handleClaudeAllowList(msg);
      return true;
    case "set_claude_user_allow_list_result":
      handleSetClaudeUserAllowListResult(msg);
      return true;
    case "restart_server_result":
      handleRestartResult(msg);
      return true;
    case "shutdown_server_result":
      handleShutdownResult(msg);
      return true;
    default:
      return false;
  }
}

function handleUpToDate(msg) {
  var updateCheckBtn = document.getElementById("settings-update-check");
  if (updateCheckBtn) {
    updateCheckBtn.innerHTML = "";
    var checkIcon = document.createElement("i");
    checkIcon.setAttribute("data-lucide", "check");
    updateCheckBtn.appendChild(checkIcon);
    updateCheckBtn.appendChild(document.createTextNode(" Up to date (v" + msg.version + ")"));
    updateCheckBtn.disabled = true;
    refreshIcons();
    setTimeout(function () {
      updateCheckBtn.innerHTML = "";
      var refreshIcon = document.createElement("i");
      refreshIcon.setAttribute("data-lucide", "refresh-cw");
      updateCheckBtn.appendChild(refreshIcon);
      updateCheckBtn.appendChild(document.createTextNode(" Check for updates"));
      updateCheckBtn.disabled = false;
      updateCheckBtn.classList.remove("settings-btn-update-available");
      refreshIcons();
    }, 3000);
  }
}

function handleUpdateStarted() {
  var updateNowBtn = document.getElementById("update-now");
  if (updateNowBtn) {
    updateNowBtn.innerHTML = '<i data-lucide="loader"></i> Updating...';
    updateNowBtn.disabled = true;
    refreshIcons();
    var spinIcon = updateNowBtn.querySelector(".lucide");
    if (spinIcon) spinIcon.classList.add("icon-spin-inline");
  }
  connectOverlay.classList.remove("hidden");
}

function handleClaudeOpenMode(msg) {
  if (msg.claudeOpenMode === "tui" || msg.claudeOpenMode === "gui") {
    store.set({ claudeOpenMode: msg.claudeOpenMode });
    var openModeToggle = document.getElementById("us-claude-open-mode");
    if (openModeToggle) openModeToggle.checked = msg.claudeOpenMode === "tui";
  }
}

function handleAutoLaunchState(msg) {
  var autoLaunchToggle = document.getElementById("ps-auto-launch");
  if (autoLaunchToggle) autoLaunchToggle.checked = !!msg.enabled;
  if (autoLaunchToggle && autoLaunchToggle.parentElement) {
    var pauseNotice = document.getElementById("ps-instance-schedules-paused");
    if (!pauseNotice) {
      pauseNotice = document.createElement("p");
      pauseNotice.id = "ps-instance-schedules-paused";
      pauseNotice.setAttribute("role", "status");
      autoLaunchToggle.parentElement.insertAdjacentElement("afterend", pauseNotice);
    }
    pauseNotice.textContent = msg.paused ? "Scheduled launches are paused in this Clay instance. Project rules are preserved." : "";
    pauseNotice.hidden = !msg.paused;
  }
  var recipeSelect = document.getElementById("ps-auto-launch-recipe");
  if (recipeSelect && Array.isArray(msg.recipes)) {
    recipeSelect.innerHTML = "";
    for (var recipeIndex = 0; recipeIndex < msg.recipes.length; recipeIndex++) {
      var recipe = msg.recipes[recipeIndex];
      var recipeKind = (recipe && typeof recipe === "object") ? recipe.kind : "";
      if (recipeKind === "pr-reviews" || recipeKind === "pr-review" || recipeKind === "prs") continue;
      var recipeId = (recipe && typeof recipe === "object") ? recipe.id : recipe;
      var recipeName = (recipe && typeof recipe === "object" && recipe.name) ? recipe.name : recipeId;
      var recipeDescription = (recipe && typeof recipe === "object" && recipe.description) ? recipe.description : "";
      var recipeOption = document.createElement("option");
      recipeOption.value = recipeId;
      recipeOption.textContent = recipeName;
      recipeOption.dataset.description = recipeDescription;
      recipeSelect.appendChild(recipeOption);
    }
    if (msg.recipeId) recipeSelect.value = msg.recipeId;
    var recipeDescriptionEl = document.getElementById("ps-auto-launch-recipe-desc");
    if (recipeDescriptionEl) {
      var selectedRecipe = recipeSelect.options[recipeSelect.selectedIndex];
      recipeDescriptionEl.textContent = selectedRecipe ? (selectedRecipe.dataset.description || "") : "";
    }
  }
  var selectedRecipes = Array.isArray(msg.selectedRecipes) ? msg.selectedRecipes : [];
  var prFixToggle = document.getElementById("ps-auto-launch-pr-fix");
  var prFixOn = selectedRecipes.indexOf("pr-review") !== -1;
  if (prFixToggle) prFixToggle.checked = prFixOn;
  var maxPassesInput = document.getElementById("ps-auto-launch-max-passes");
  if (maxPassesInput && msg.maxPasses) maxPassesInput.value = msg.maxPasses;
  var maxPassesWrap = document.getElementById("ps-auto-launch-pr-fix-passes");
  if (maxPassesWrap) maxPassesWrap.classList.toggle("hidden", !prFixOn);
  var cronInput = document.getElementById("ps-auto-launch-cron");
  if (cronInput && msg.cron) cronInput.value = msg.cron;
  var vendorInput = document.getElementById("ps-auto-launch-vendor");
  if (vendorInput && msg.vendorWeights) {
    var claudeWeight = parseInt(msg.vendorWeights.claude, 10) || 0;
    var codexWeight = parseInt(msg.vendorWeights.codex, 10) || 0;
    var totalWeight = claudeWeight + codexWeight;
    var claudePct = totalWeight > 0 ? Math.round((claudeWeight / totalWeight) * 100) : 60;
    vendorInput.value = claudePct;
    var vendorLabel = document.getElementById("ps-auto-launch-vendor-label");
    if (vendorLabel) vendorLabel.textContent = claudePct + "% Claude · " + (100 - claudePct) + "% Codex";
  }
  var statusEl = document.getElementById("ps-auto-launch-status");
  if (statusEl) {
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }
}

function handleClaudeAllowList(msg) {
  var allowListTextArea = document.getElementById("us-claude-allow-list");
  if (allowListTextArea && Array.isArray(msg.user)) {
    allowListTextArea.value = msg.user.join("\n");
  }
  var managedList = document.getElementById("us-claude-allow-managed");
  if (managedList && Array.isArray(msg.managed)) {
    managedList.innerHTML = "";
    for (var managedIndex = 0; managedIndex < msg.managed.length; managedIndex++) {
      var managedCode = document.createElement("code");
      managedCode.textContent = msg.managed[managedIndex];
      managedList.appendChild(managedCode);
      if (managedIndex < msg.managed.length - 1) managedList.appendChild(document.createTextNode(" "));
    }
  }
}

function handleSetClaudeUserAllowListResult(msg) {
  var allowStatus = document.getElementById("us-claude-allow-status");
  if (allowStatus) {
    if (msg.ok) {
      allowStatus.textContent = "Saved (applies on next claude invocation)";
      allowStatus.classList.remove("error");
      setTimeout(function () {
        if (allowStatus.textContent.indexOf("Saved") === 0) allowStatus.textContent = "";
      }, 4000);
    } else {
      allowStatus.textContent = "Save failed: " + (msg.error || "unknown");
      allowStatus.classList.add("error");
    }
  }
}
