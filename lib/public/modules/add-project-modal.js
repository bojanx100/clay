// add-project-modal.js - Add, create, and clone project dialog

import { escapeHtml, showToast } from './utils.js';
import { refreshIcons } from './icons.js';
import { parseEmojis } from './markdown.js';
import { store } from './store.js';
import { sendUserAction } from './app-connection.js';
import { getCachedRemovedProjects, switchProject } from './app-projects.js';

var addProjectModal = null;
var addProjectInput = null;
var addProjectCloneInput = null;
var addProjectCloneProgress = null;
var addProjectSuggestions = null;
var addProjectError = null;
var addProjectOk = null;
var addProjectCancel = null;
var addProjectModeBtns = null;
var addProjectPanels = null;
var addProjectRemoved = null;
var addProjectPrefixEl = null;
var addProjectPathLabel = null;
var addProjectPathHint = null;
var addProjectPrefixValue = "";
var addProjectDebounce = null;
var addProjectActiveIdx = -1;
var addProjectMode = "existing";
var addProjectPathValues = { existing: "/", create: "~/clay-projects/new-project" };

export function initAddProjectModal() {
  addProjectModal = document.getElementById("add-project-modal");
  addProjectInput = document.getElementById("add-project-input");
  addProjectCloneInput = document.getElementById("add-project-clone-input");
  addProjectCloneProgress = document.getElementById("add-project-clone-progress");
  addProjectSuggestions = document.getElementById("add-project-suggestions");
  addProjectError = document.getElementById("add-project-error");
  addProjectOk = document.getElementById("add-project-ok");
  addProjectCancel = document.getElementById("add-project-cancel");
  addProjectModeBtns = addProjectModal.querySelectorAll(".add-project-mode-btn");
  addProjectPanels = addProjectModal.querySelectorAll(".add-project-panel");
  addProjectRemoved = document.getElementById("add-project-removed");
  addProjectPrefixEl = document.getElementById("add-project-prefix");
  addProjectPathLabel = document.getElementById("add-project-path-label");
  addProjectPathHint = document.getElementById("add-project-path-hint");

  for (var mbi = 0; mbi < addProjectModeBtns.length; mbi++) {
    addProjectModeBtns[mbi].addEventListener("click", function () {
      if (this.disabled) return;
      switchAddProjectMode(this.dataset.mode);
    });
  }

  addProjectInput.addEventListener("focus", function () {
    var val = addProjectInput.value;
    if ((val || addProjectPrefixValue) && addProjectSuggestions.children.length === 0) {
      requestBrowseDir(val);
    } else if (addProjectSuggestions.children.length > 0) {
      addProjectSuggestions.classList.remove("hidden");
    }
  });

  addProjectModal.querySelector(".confirm-dialog").addEventListener("click", function (e) {
    if (e.target === addProjectInput || addProjectInput.contains(e.target)) return;
    if (e.target === addProjectSuggestions || addProjectSuggestions.contains(e.target)) return;
    addProjectSuggestions.classList.add("hidden");
    addProjectActiveIdx = -1;
  });

  addProjectInput.addEventListener("input", function () {
    addProjectPathValues[addProjectMode] = addProjectInput.value;
    addProjectError.classList.add("hidden");
    if (addProjectDebounce) clearTimeout(addProjectDebounce);
    addProjectDebounce = setTimeout(function () {
      requestBrowseDir(addProjectInput.value);
    }, 200);
  });

  addProjectInput.addEventListener("keydown", handlePathKeydown);
  addProjectCloneInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitAddProject(); }
    if (e.key === "Escape") { e.preventDefault(); closeAddProjectModal(); }
  });

  addProjectOk.addEventListener("click", function () { submitAddProject(); });
  addProjectCancel.addEventListener("click", function () { closeAddProjectModal(); });
  addProjectModal.querySelector(".confirm-backdrop").addEventListener("click", function () {
    closeAddProjectModal();
  });

  var projectListAddBtn = document.getElementById("project-list-add");
  if (projectListAddBtn) {
    projectListAddBtn.addEventListener("click", function () {
      openAddProjectModal();
    });
  }
}

function handlePathKeydown(e) {
  var items = addProjectSuggestions.querySelectorAll(".add-project-suggestion-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (items.length > 0) setActiveIdx(addProjectActiveIdx < items.length - 1 ? addProjectActiveIdx + 1 : 0);
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (items.length > 0) setActiveIdx(addProjectActiveIdx > 0 ? addProjectActiveIdx - 1 : items.length - 1);
    return;
  }
  if (e.key === "Tab") {
    var target = addProjectActiveIdx >= 0 && addProjectActiveIdx < items.length
      ? items[addProjectActiveIdx]
      : items.length > 0 ? items[0] : null;
    if (!target) return;
    e.preventDefault();
    chooseSuggestedPath(target.dataset.path);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    if (addProjectActiveIdx >= 0 && addProjectActiveIdx < items.length) {
      chooseSuggestedPath(items[addProjectActiveIdx].dataset.path);
      return;
    }
    submitAddProject();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeAddProjectModal();
  }
}

function switchAddProjectMode(mode) {
  if (addProjectMode !== "clone") addProjectPathValues[addProjectMode] = addProjectInput.value;
  addProjectMode = mode;
  for (var mi = 0; mi < addProjectModeBtns.length; mi++) {
    addProjectModeBtns[mi].classList.toggle("active", addProjectModeBtns[mi].dataset.mode === mode);
  }
  for (var pi = 0; pi < addProjectPanels.length; pi++) {
    var panelMode = addProjectPanels[pi].dataset.panel;
    var active = panelMode === mode || (panelMode === "path" && mode !== "clone");
    addProjectPanels[pi].classList.toggle("active", active);
  }
  addProjectError.classList.add("hidden");
  addProjectCloneProgress.classList.add("hidden");
  addProjectSuggestions.classList.add("hidden");
  addProjectActiveIdx = -1;
  if (mode === "existing") {
    addProjectOk.textContent = "Add";
    addProjectPathLabel.textContent = "Existing project folder";
    addProjectPathHint.textContent = "Select the folder that already contains your project.";
    addProjectInput.placeholder = addProjectPrefixValue ? "project-folder" : "/path/to/project";
    addProjectInput.value = addProjectPathValues.existing;
  } else if (mode === "create") {
    addProjectOk.textContent = "Create";
    addProjectPathLabel.textContent = "New project folder";
    addProjectPathHint.textContent = "Clay will create this exact folder and initialize Git inside it.";
    addProjectInput.placeholder = addProjectPrefixValue ? "projects/new-project" : "~/projects/new-project";
    addProjectInput.value = addProjectPathValues.create;
  } else {
    addProjectOk.textContent = "Clone";
  }
  setTimeout(function () {
    if (mode === "clone") addProjectCloneInput.focus();
    else {
      addProjectInput.focus();
      if (mode === "create") {
        var nameStart = addProjectInput.value.lastIndexOf("/") + 1;
        addProjectInput.setSelectionRange(nameStart, addProjectInput.value.length);
      } else {
        addProjectInput.setSelectionRange(addProjectInput.value.length, addProjectInput.value.length);
      }
    }
  }, 50);
}

export function openAddProjectModal() {
  addProjectModal.classList.remove("hidden");
  addProjectCloneInput.value = "";
  addProjectError.classList.add("hidden");
  addProjectError.textContent = "";
  addProjectCloneProgress.classList.add("hidden");
  addProjectSuggestions.classList.add("hidden");
  addProjectSuggestions.innerHTML = "";
  addProjectActiveIdx = -1;
  addProjectOk.disabled = false;
  var st = store.snap();
  var existingBtn = addProjectModal.querySelector('.add-project-mode-btn[data-mode="existing"]');
  existingBtn.disabled = false;
  if (st.isOsUsers) {
    var myUser = st.cachedAllUsers.find(function (u) { return u.id === st.myUserId; });
    var isAdmin = myUser && myUser.role === "admin";
    if (!isAdmin && myUser && myUser.linuxUser) {
      addProjectPrefixValue = "/home/" + myUser.linuxUser + "/";
      addProjectPrefixEl.textContent = addProjectPrefixValue;
      addProjectPrefixEl.classList.remove("hidden");
      addProjectPathValues = { existing: "", create: "new-project" };
    } else {
      addProjectPrefixValue = "";
      addProjectPrefixEl.classList.add("hidden");
      addProjectPathValues = { existing: "/", create: "/var/clay/projects/new-project" };
    }
  } else {
    addProjectPrefixValue = "";
    addProjectPrefixEl.classList.add("hidden");
    addProjectPathValues = { existing: "/", create: "~/clay-projects/new-project" };
  }
  addProjectMode = "existing";
  addProjectInput.value = addProjectPathValues.existing;
  switchAddProjectMode("existing");
  renderRemovedProjectsList();
}

function renderRemovedProjectsList() {
  var removedProjects = getCachedRemovedProjects();
  addProjectRemoved.innerHTML = "";
  if (!removedProjects || removedProjects.length === 0) {
    addProjectRemoved.classList.add("hidden");
    return;
  }
  addProjectRemoved.classList.remove("hidden");
  for (var ri = 0; ri < removedProjects.length; ri++) {
    var rp = removedProjects[ri];
    var item = document.createElement("div");
    item.className = "add-project-removed-item";
    item.dataset.path = rp.path;
    item.addEventListener("click", function () {
      sendUserAction({ type: "add_project", path: this.dataset.path });
      closeAddProjectModal();
    });
    var iconEl = document.createElement("span");
    iconEl.className = "add-project-removed-icon";
    iconEl.textContent = rp.icon || "\uD83D\uDCC1";
    item.appendChild(iconEl);
    var info = document.createElement("div");
    info.className = "add-project-removed-info";
    var nameEl = document.createElement("div");
    nameEl.className = "add-project-removed-name";
    nameEl.textContent = rp.title || rp.path.split("/").pop() || rp.path;
    info.appendChild(nameEl);
    var pathEl = document.createElement("div");
    pathEl.className = "add-project-removed-path";
    pathEl.textContent = rp.path;
    info.appendChild(pathEl);
    item.appendChild(info);
    addProjectRemoved.appendChild(item);
  }
  try { parseEmojis(addProjectRemoved); } catch (e) {}
}

export function closeAddProjectModal() {
  addProjectModal.classList.add("hidden");
  addProjectInput.value = "";
  addProjectCloneInput.value = "";
  addProjectSuggestions.classList.add("hidden");
  addProjectSuggestions.innerHTML = "";
  addProjectError.classList.add("hidden");
  addProjectCloneProgress.classList.add("hidden");
  addProjectActiveIdx = -1;
  addProjectPrefixValue = "";
  addProjectPrefixEl.classList.add("hidden");
  if (addProjectDebounce) { clearTimeout(addProjectDebounce); addProjectDebounce = null; }
}

function getFullPath(inputVal) {
  return addProjectPrefixValue + inputVal;
}

function stripPrefix(fullPath) {
  if (addProjectPrefixValue && fullPath.indexOf(addProjectPrefixValue) === 0) {
    return fullPath.slice(addProjectPrefixValue.length);
  }
  return fullPath;
}

function requestBrowseDir(val) {
  sendUserAction({ type: "browse_dir", path: getFullPath(val) });
}

function chooseSuggestedPath(pathValue) {
  addProjectInput.value = stripPrefix(pathValue + "/");
  addProjectPathValues[addProjectMode] = addProjectInput.value;
  addProjectInput.focus();
  addProjectError.classList.add("hidden");
  requestBrowseDir(addProjectInput.value);
}

export function handleBrowseDirResult(msg) {
  if (addProjectMode === "clone") return;
  if (msg.path && msg.path !== getFullPath(addProjectInput.value)) return;
  addProjectSuggestions.innerHTML = "";
  addProjectActiveIdx = -1;
  if (msg.error || !(msg.entries || []).length) {
    addProjectSuggestions.classList.add("hidden");
    return;
  }
  for (var si = 0; si < msg.entries.length; si++) {
    var entry = msg.entries[si];
    var item = document.createElement("div");
    item.className = "add-project-suggestion-item";
    item.dataset.path = entry.path;
    item.innerHTML = '<i data-lucide="folder"></i><span class="add-project-suggestion-name">' +
      escapeHtml(entry.name) + '</span>';
    item.addEventListener("click", function () {
      chooseSuggestedPath(this.dataset.path);
    });
    addProjectSuggestions.appendChild(item);
  }
  addProjectSuggestions.classList.remove("hidden");
  refreshIcons();
}

export function handleAddProjectResult(msg) {
  addProjectCloneProgress.classList.add("hidden");
  if (msg.ok) {
    closeAddProjectModal();
    if (msg.existing) {
      showToast("Project already registered", "info");
    } else {
      var toastMsg = addProjectMode === "create" ? "Project created" : addProjectMode === "clone" ? "Project cloned" : "Project added";
      showToast(toastMsg, "success");
      if (msg.slug) switchProject(msg.slug);
    }
  } else {
    addProjectError.textContent = msg.error || "Failed to add project";
    addProjectError.classList.remove("hidden");
    addProjectOk.disabled = false;
  }
}

export function handleCloneProgress(msg) {
  if (msg.status === "cloning") addProjectCloneProgress.classList.remove("hidden");
}

function setActiveIdx(idx) {
  var items = addProjectSuggestions.querySelectorAll(".add-project-suggestion-item");
  addProjectActiveIdx = idx;
  for (var ai = 0; ai < items.length; ai++) {
    items[ai].classList.toggle("active", ai === idx);
    if (ai === idx) items[ai].scrollIntoView({ block: "nearest" });
  }
}

function submitAddProject() {
  addProjectError.classList.add("hidden");
  addProjectOk.disabled = true;
  if (addProjectMode === "existing" || addProjectMode === "create") {
    var projectPath = getFullPath(addProjectInput.value).replace(/\/+$/, "");
    if (!projectPath) { addProjectOk.disabled = false; return; }
    var type = addProjectMode === "create" ? "create_project" : "add_project";
    if (!sendUserAction({ type: type, path: projectPath })) addProjectOk.disabled = false;
  } else {
    var url = addProjectCloneInput.value.trim();
    if (!url) { addProjectOk.disabled = false; return; }
    if (!sendUserAction({ type: "clone_project", url: url })) addProjectOk.disabled = false;
  }
}
