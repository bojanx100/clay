import { iconHtml, refreshIcons } from './icons.js';
import { sendUserAction } from './app-connection.js';
import { openImportSessionPicker } from './sidebar-sessions-import.js';

function setPosition(anchorBtn, menu, canFlipUp) {
  requestAnimationFrame(function () {
    var btnRect = anchorBtn.getBoundingClientRect();
    menu.style.position = "fixed";
    menu.style.top = (btnRect.bottom + 2) + "px";
    menu.style.left = btnRect.left + "px";
    menu.style.right = "auto";
    var menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth - 8) {
      menu.style.left = "auto";
      menu.style.right = (window.innerWidth - btnRect.right) + "px";
    }
    if (canFlipUp && menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (btnRect.top - menuRect.height - 2) + "px";
    }
  });
}

function showCodexStartMenu(anchorBtn, deps) {
  deps.closeMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var importItem = document.createElement("button");
  importItem.className = "session-ctx-item";
  importItem.innerHTML = iconHtml("download") + " <span>Import session...</span>";
  importItem.title = "Pick a Codex or GitHub Copilot Codex session to bring into Clay (includes closed/archived sessions)";
  importItem.addEventListener("click", function (e) {
    e.stopPropagation();
    deps.closeMenu();
    openImportSessionPicker("codex");
  });
  menu.appendChild(importItem);

  document.body.appendChild(menu);
  deps.setMenu(menu);
  refreshIcons();
  setPosition(anchorBtn, menu, false);
}

function showClaudeStartMenu(anchorBtn, deps) {
  deps.closeMenu();

  var menu = document.createElement("div");
  menu.className = "session-ctx-menu";

  var skipItem = document.createElement("button");
  skipItem.className = "session-ctx-item";
  skipItem.innerHTML = iconHtml("shield-off") + " <span>Skip permissions (TUI)</span>";
  skipItem.title = "Start a terminal session with --dangerously-skip-permissions";
  skipItem.addEventListener("click", function (e) {
    e.stopPropagation();
    deps.closeMenu();
    sendUserAction({
      type: "new_session",
      vendor: "claude",
      mode: "tui",
      dangerouslySkipPermissions: true,
    });
  });
  menu.appendChild(skipItem);

  var importItem = document.createElement("button");
  importItem.className = "session-ctx-item";
  importItem.innerHTML = iconHtml("download") + " <span>Import session...</span>";
  importItem.title = "Pick a Claude or GitHub Copilot Claude session to bring into Clay (includes closed/archived sessions)";
  importItem.addEventListener("click", function (e) {
    e.stopPropagation();
    deps.closeMenu();
    openImportSessionPicker("claude");
  });
  menu.appendChild(importItem);

  document.body.appendChild(menu);
  deps.setMenu(menu);
  refreshIcons();
  setPosition(anchorBtn, menu, true);
}

export function renderSessionTopActions(deps) {
  var wrap = document.createElement("div");
  wrap.className = "session-top-actions";

  var claudeCell = document.createElement("div");
  claudeCell.className = "session-top-action-split";

  var claudeBtn = document.createElement("button");
  claudeBtn.className = "session-top-action split-main";
  claudeBtn.type = "button";
  claudeBtn.title = "New Claude session";
  claudeBtn.innerHTML = '<img src="/claude-code-avatar.png" class="session-top-action-icon" alt=""><span>Claude</span>';
  claudeBtn.addEventListener("click", function () {
    sendUserAction({ type: "new_session", vendor: "claude" });
  });
  claudeCell.appendChild(claudeBtn);

  var claudeChevron = document.createElement("button");
  claudeChevron.className = "session-top-action split-chevron";
  claudeChevron.type = "button";
  claudeChevron.title = "More Claude launch options";
  claudeChevron.setAttribute("aria-label", "More Claude launch options");
  claudeChevron.innerHTML = iconHtml("chevron-down");
  claudeChevron.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (deps.hasMenu()) { deps.closeMenu(); return; }
    showClaudeStartMenu(claudeChevron, deps);
  });
  claudeCell.appendChild(claudeChevron);

  wrap.appendChild(claudeCell);

  var codexCell = document.createElement("div");
  codexCell.className = "session-top-action-split";

  var codexBtn = document.createElement("button");
  codexBtn.className = "session-top-action split-main";
  codexBtn.type = "button";
  codexBtn.title = "New Codex session";
  codexBtn.innerHTML = '<img src="/codex-avatar.png" class="session-top-action-icon" alt=""><span>Codex</span>';
  codexBtn.addEventListener("click", function () {
    sendUserAction({ type: "new_session", vendor: "codex" });
  });
  codexCell.appendChild(codexBtn);

  var codexChevron = document.createElement("button");
  codexChevron.className = "session-top-action split-chevron";
  codexChevron.type = "button";
  codexChevron.title = "More Codex launch options";
  codexChevron.setAttribute("aria-label", "More Codex launch options");
  codexChevron.innerHTML = iconHtml("chevron-down");
  codexChevron.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (deps.hasMenu()) { deps.closeMenu(); return; }
    showCodexStartMenu(codexChevron, deps);
  });
  codexCell.appendChild(codexChevron);

  wrap.appendChild(codexCell);

  return wrap;
}
