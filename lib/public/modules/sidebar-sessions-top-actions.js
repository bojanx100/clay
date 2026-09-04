import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { VENDOR_AVATARS, VENDOR_NAMES, VENDOR_ORDER, VENDOR_HOMEPAGES } from './vendor-ui.js';
import { openImportSessionPicker } from './sidebar-sessions-import.js';

function setPosition(anchorBtn, menu) {
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
    if (menuRect.bottom > window.innerHeight - 8) {
      menu.style.top = (btnRect.top - menuRect.height - 2) + "px";
    }
  });
}

function appendSeparator(menu) {
  var separator = document.createElement("div");
  separator.className = "session-ctx-sep";
  menu.appendChild(separator);
}

function appendVendorItems(menu, deps, installed, defaultVendor) {
  for (var i = 0; i < VENDOR_ORDER.length; i++) {
    (function (vendor) {
      var isInstalled = installed.indexOf(vendor) !== -1;
      var name = VENDOR_NAMES[vendor] || vendor;
      var item = document.createElement("button");
      item.className = "session-ctx-item session-new-vendor";
      if (!isInstalled) item.classList.add("disabled");
      if (vendor === defaultVendor) item.classList.add("active");
      item.innerHTML = '<img src="' + (VENDOR_AVATARS[vendor] || VENDOR_AVATARS.claude) +
        '" class="session-top-action-icon" alt="">' +
        '<span class="session-new-vendor-name">' + name + '</span>' +
        (isInstalled ? "" : '<span class="session-new-vendor-note">Not installed</span>' + iconHtml("external-link"));
      item.title = isInstalled ? "New " + name + " session" : "Open the " + name + " website";
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        deps.closeMenu();
        if (!isInstalled) {
          window.open(VENDOR_HOMEPAGES[vendor], "_blank", "noopener");
          return;
        }
        deps.startNewSession(vendor);
      });
      menu.appendChild(item);
    })(VENDOR_ORDER[i]);
  }
}

function appendCoordinatorItem(menu, deps, vendor) {
  var name = VENDOR_NAMES[vendor] || vendor;
  var item = document.createElement("button");
  item.className = "session-ctx-item";
  item.innerHTML = iconHtml("git-branch") + " <span>New " + name + " coordinator</span>";
  item.addEventListener("click", function (e) {
    e.stopPropagation();
    deps.closeMenu();
    deps.startNewSession(vendor, { coordinator: true });
  });
  menu.appendChild(item);
}

function appendAlternateLaunchItems(menu, deps, installed) {
  appendSeparator(menu);
  for (var i = 0; i < VENDOR_ORDER.length; i++) {
    if (installed.indexOf(VENDOR_ORDER[i]) !== -1) appendCoordinatorItem(menu, deps, VENDOR_ORDER[i]);
  }

  if (installed.indexOf("claude") !== -1 && store.get('claudeOpenMode') === "tui") {
    var skipItem = document.createElement("button");
    skipItem.className = "session-ctx-item";
    skipItem.innerHTML = iconHtml("shield-off") + " <span>Skip permissions (Claude TUI)</span>";
    skipItem.title = "Start a terminal session with --dangerously-skip-permissions";
    skipItem.addEventListener("click", function (e) {
      e.stopPropagation();
      deps.closeMenu();
      deps.startNewSession("claude", { mode: "tui", dangerouslySkipPermissions: true });
    });
    menu.appendChild(skipItem);
  }
}

function appendImportItem(menu, deps, vendor, label) {
  var item = document.createElement("button");
  item.className = "session-ctx-item";
  item.innerHTML = iconHtml("download") + " <span>Import " + label + " session...</span>";
  item.addEventListener("click", function (e) {
    e.stopPropagation();
    deps.closeMenu();
    openImportSessionPicker(vendor);
  });
  menu.appendChild(item);
}

function showStartMenu(anchorBtn, deps) {
  deps.closeMenu();
  var installed = store.get('installedVendors') || [];
  var defaultVendor = deps.resolveDefaultVendor();
  var menu = document.createElement("div");
  menu.className = "session-ctx-menu session-new-menu";

  appendVendorItems(menu, deps, installed, defaultVendor);
  appendAlternateLaunchItems(menu, deps, installed);
  appendSeparator(menu);
  appendImportItem(menu, deps, "claude", "Claude");
  appendImportItem(menu, deps, "codex", "Codex");

  document.body.appendChild(menu);
  deps.setMenu(menu);
  refreshIcons();
  setPosition(anchorBtn, menu);
}

export function renderSessionTopActions(deps) {
  var defaultVendor = deps.resolveDefaultVendor();
  var wrap = document.createElement("div");
  wrap.className = "session-top-actions";

  var cell = document.createElement("div");
  cell.className = "session-top-action-split";

  var mainBtn = document.createElement("button");
  mainBtn.className = "session-top-action split-main";
  mainBtn.type = "button";
  mainBtn.title = "New " + (VENDOR_NAMES[defaultVendor] || defaultVendor) + " session";
  mainBtn.innerHTML = '<img src="' + (VENDOR_AVATARS[defaultVendor] || VENDOR_AVATARS.claude) +
    '" class="session-top-action-icon" alt=""><span>New session</span>';
  mainBtn.addEventListener("click", function () {
    deps.startNewSession(defaultVendor);
  });
  cell.appendChild(mainBtn);

  var chevron = document.createElement("button");
  chevron.className = "session-top-action split-chevron";
  chevron.type = "button";
  chevron.title = "Choose a vendor or launch mode";
  chevron.setAttribute("aria-label", "Choose a vendor or launch mode");
  chevron.innerHTML = iconHtml("chevron-down");
  chevron.addEventListener("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    if (deps.hasMenu()) {
      deps.closeMenu();
      return;
    }
    showStartMenu(chevron, deps);
  });
  cell.appendChild(chevron);
  wrap.appendChild(cell);
  return wrap;
}
