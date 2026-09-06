import { escapeHtml } from './utils.js';
import { sendUserAction } from './app-connection.js';

var importPickerEl = null;
var importPickerVendor = null;
// Transient per-modal state, deliberately not persisted. Import is a recovery
// surface, so it opens with every recoverable closed conversation visible;
// owners can still hide Coop-managed rows when they want a shorter list.
var importPickerIncludeCoopManaged = true;

function vendorLabel(vendor) {
  if (vendor === "codex") return "Codex via OpenAI";
  if (vendor === "github-copilot") return "GitHub Copilot";
  return "Claude via Anthropic";
}

function closeImportSessionPicker() {
  if (importPickerEl && importPickerEl.parentNode) {
    importPickerEl.parentNode.removeChild(importPickerEl);
  }
  importPickerEl = null;
  importPickerVendor = null;
}

function requestImportSessionList() {
  sendUserAction({
    type: "list_cli_sessions",
    vendor: importPickerVendor || "",
    includeCoopManaged: importPickerIncludeCoopManaged,
  });
}

export function openImportSessionPicker(vendorFilter) {
  closeImportSessionPicker();
  importPickerVendor = vendorFilter || null;
  importPickerIncludeCoopManaged = true;

  var overlay = document.createElement("div");
  overlay.className = "import-session-overlay";
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;display:flex;align-items:center;justify-content:center";

  var modal = document.createElement("div");
  modal.className = "import-session-modal";
  modal.style.cssText = "background:var(--bg-alt);color:var(--text);border:1px solid var(--border);border-radius:10px;width:520px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;overflow:hidden";

  var header = document.createElement("div");
  header.style.cssText = "padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between";
  var headerLabel = importPickerVendor === "github-copilot" ? "Import GitHub Copilot session" : importPickerVendor === "codex" ? "Import Codex session" : importPickerVendor === "claude" ? "Import Claude session" : "Import session from CLI";
  header.innerHTML = '<strong>' + escapeHtml(headerLabel) + '</strong>';
  var closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  closeBtn.style.cssText = "background:none;border:none;color:var(--text);font-size:22px;cursor:pointer;padding:0 4px";
  closeBtn.addEventListener("click", closeImportSessionPicker);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  var searchWrap = document.createElement("div");
  searchWrap.style.cssText = "padding:8px 10px;border-bottom:1px solid var(--border)";
  var searchInput = document.createElement("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search sessions by title or ID...";
  searchInput.setAttribute("aria-label", "Search sessions by title or ID");
  searchInput.className = "import-session-search";
  searchInput.style.cssText = "width:100%;box-sizing:border-box;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:7px 10px;font:inherit;outline:none";
  searchInput.addEventListener("input", filterImportPickerRows);
  searchWrap.appendChild(searchInput);

  var coopToggleLabel = document.createElement("label");
  coopToggleLabel.style.cssText = "display:flex;align-items:center;gap:7px;margin-top:8px;font-size:12px;color:var(--text-muted);cursor:pointer;user-select:none";
  var coopToggle = document.createElement("input");
  coopToggle.type = "checkbox";
  coopToggle.className = "import-session-coop-toggle";
  coopToggle.checked = importPickerIncludeCoopManaged;
  coopToggle.style.cssText = "margin:0;cursor:pointer";
  coopToggle.addEventListener("change", function () {
    importPickerIncludeCoopManaged = !!coopToggle.checked;
    var listBody = importPickerEl && importPickerEl.querySelector(".import-session-body");
    if (listBody) listBody.textContent = "Loading...";
    requestImportSessionList();
  });
  coopToggleLabel.appendChild(coopToggle);
  coopToggleLabel.appendChild(document.createTextNode("Include Coop-managed sessions"));
  coopToggleLabel.title = "Show sessions Coop owned that were closed or auto-archived. Importing one hands it back to you.";
  searchWrap.appendChild(coopToggleLabel);

  modal.appendChild(searchWrap);

  var body = document.createElement("div");
  body.className = "import-session-body";
  body.style.cssText = "padding:8px;overflow-y:auto;flex:1;min-height:120px";
  body.textContent = "Loading...";
  modal.appendChild(body);

  overlay.appendChild(modal);
  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeImportSessionPicker();
  });
  document.body.appendChild(overlay);
  importPickerEl = overlay;

  requestImportSessionList();
}

export function handleCliSessionList(sessions, vendor) {
  if (!importPickerEl) return;
  if (vendor && importPickerVendor && vendor !== importPickerVendor) return;
  var body = importPickerEl.querySelector(".import-session-body");
  if (!body) return;
  body.innerHTML = "";

  var filtered = sessions || [];
  if (importPickerVendor) {
    filtered = filtered.filter(function (s) {
      var v = s.vendor || "claude";
      if (v === "github-copilot") return s.copilotFamily === importPickerVendor;
      return v === importPickerVendor;
    });
  }

  if (filtered.length === 0) {
    body.style.cssText += ";color:var(--text-muted);text-align:center;padding:24px";
    body.textContent = importPickerIncludeCoopManaged
      ? "No CLI sessions to import."
      : "No CLI sessions to import. Coop-managed sessions are hidden — tick the box above to include them.";
    return;
  }

  for (var i = 0; i < filtered.length; i++) {
    var s = filtered[i];
    var vendorName = s.vendor || "claude";
    var row = document.createElement("button");
    row.type = "button";
    row.style.cssText = "display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--border-subtle);color:var(--text);padding:10px 12px;cursor:pointer;font:inherit";
    row.addEventListener("mouseover", function () { this.style.background = "var(--sidebar-hover)"; });
    row.addEventListener("mouseout", function () { this.style.background = "none"; });

    var date = s.lastActivity ? new Date(s.lastActivity).toLocaleString() : "";
    var metaParts = [];
    if (vendorName === "github-copilot") {
      metaParts.push(importPickerVendor === "claude" ? "GitHub Copilot Claude" : importPickerVendor === "codex" ? "GitHub Copilot Codex" : "GitHub Copilot");
    }
    if (s.tombstoned) metaParts.push("deleted");
    else if (s.hidden) metaParts.push("closed");
    if (s.archived) metaParts.push("archived");
    // Importing one of these releases it from Coop, so say so on the row rather
    // than letting it read as an ordinary closed session.
    if (s.coopManaged) metaParts.push("Coop-managed → becomes yours");
    if (date) metaParts.push(date);
    if (s.cliSessionId) metaParts.push(s.cliSessionId);
    var meta = metaParts.join(" • ");
    var tooltip = s.preview ? String(s.preview).slice(0, 800) : (s.title || "");
    row.title = tooltip;
    row.dataset.searchText = ((s.title || "") + " " + meta + " " + vendorName).toLowerCase();
    var badge = importPickerVendor
      ? ""
      : '<span style="display:inline-block;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:1px 6px;border-radius:4px;margin-right:6px;background:' +
        (vendorName === "codex" ? "#2d4a6b;color:#9fd0ff" : vendorName === "github-copilot" ? "#254d38;color:#9df0bd" : "#3a3a45;color:#cfcfd6") + '">' + escapeHtml(vendorLabel(vendorName)) + '</span>';
    row.innerHTML =
      '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' +
        badge +
        escapeHtml(s.title || "(untitled)") +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' +
        escapeHtml(meta) +
      '</div>';

    (function (cliSessionId, rowVendor, btn) {
      btn.addEventListener("click", function () {
        if (sendUserAction({ type: "import_cli_session", cliSessionId: cliSessionId, vendor: rowVendor })) {
          btn.disabled = true;
          btn.style.opacity = "0.5";
        }
      });
    })(s.cliSessionId, vendorName, row);

    body.appendChild(row);
  }
  filterImportPickerRows();
}

function filterImportPickerRows() {
  if (!importPickerEl) return;
  var input = importPickerEl.querySelector(".import-session-search");
  var body = importPickerEl.querySelector(".import-session-body");
  if (!body) return;
  var q = input ? input.value.trim().toLowerCase() : "";
  var rows = body.children;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var txt = r.dataset && r.dataset.searchText ? r.dataset.searchText : "";
    r.style.display = !q || txt.indexOf(q) !== -1 ? "" : "none";
  }
}

export function handleCliSessionImported() {
  if (importPickerEl) requestImportSessionList();
}
