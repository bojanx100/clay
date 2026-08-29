import { escapeHtml } from './utils.js';
import { liveUiControlsHtml } from './live-ui.js';
import { isWorkspaceGroupCollapsed, workspaceGroupDomId } from './workspace-group-collapse.js';

export function workspaceGroupStart(key, label, icon, className, elementId, statusText) {
  var contentId = workspaceGroupDomId(key) + "-content";
  var collapsed = isWorkspaceGroupCollapsed(key);
  return '<section class="ws-section ' + escapeHtml(className || "") +
    '" data-workspace-group="' + escapeHtml(key) + '"' +
    (elementId ? ' id="' + escapeHtml(elementId) + '"' : '') + '>' +
    '<div class="ws-section-heading"><button type="button" class="ws-section-toggle" ' +
    'data-workspace-group-toggle="' + escapeHtml(key) + '" aria-expanded="' +
    (collapsed ? "false" : "true") + '" aria-controls="' + contentId + '">' +
    '<span>' + escapeHtml(label) + '</span>' + (statusText ? '<span class="ws-group-status">' + escapeHtml(statusText) + '</span>' : '') +
    '<i data-lucide="' + escapeHtml(icon) + '"></i>' +
    '<i class="ws-group-chevron" data-lucide="chevron-down"></i></button></div>' +
    '<div id="' + contentId + '" class="ws-section-content"' +
    (collapsed ? ' hidden' : '') + '>';
}

export function workspaceGroupEnd() {
  return '</div></section>';
}

function stateChip(state) {
  if (!state) return "";
  var cls = "ws-chip ws-state-" + escapeHtml(state.toLowerCase());
  return '<span class="' + cls + '">' + escapeHtml(state) + '</span>';
}

function linkBtn(href, icon, label, className) {
  return '<a class="ws-linkbtn ' + escapeHtml(className || "") + '" href="' +
    escapeHtml(href) + '" target="_blank" rel="noopener"><i data-lucide="' +
    icon + '"></i>' + escapeHtml(label) + '</a>';
}

function mediaThumbsHtml(media) {
  if (!media || !media.length) return "";
  var html = '<div class="ws-media-grid">';
  for (var i = 0; i < media.length; i++) {
    var m = media[i];
    var url = escapeHtml(m.url);
    if (m.type === "image") {
      html += '<a class="ws-thumb" href="' + url +
        '" target="_blank" rel="noopener" title="' + url +
        '"><img src="' + url + '" loading="lazy" alt=""></a>';
    } else if (m.type === "video") {
      html += '<a class="ws-thumb ws-thumb-video" href="' + url +
        '" target="_blank" rel="noopener" title="' + url +
        '"><i data-lucide="play-circle"></i></a>';
    } else {
      html += '<a class="ws-thumb ws-thumb-link" href="' + url +
        '" target="_blank" rel="noopener" title="' + url +
        '"><i data-lucide="paperclip"></i></a>';
    }
  }
  return html + '</div>';
}

export function sessionMediaHtml(media) {
  if (!media || !media.length) return "";
  var html = '<div class="ws-media-grid">';
  for (var i = 0; i < media.length; i++) {
    var url = escapeHtml(media[i].url);
    html += '<div class="ws-shot">' +
      '<a class="ws-thumb" href="' + url +
      '" target="_blank" rel="noopener" title="Open in new tab"><img src="' +
      url + '" loading="lazy" alt=""></a>' +
      '<div class="ws-shot-actions">' +
      '<button class="ws-shot-btn" data-copy="' + url +
      '" title="Copy image"><i data-lucide="copy"></i></button>' +
      '<button class="ws-shot-btn" data-add="' + url +
      '" title="Add to chat message"><i data-lucide="message-square-plus"></i></button>' +
      '</div></div>';
  }
  return html + '</div>';
}

function itemCardHtml(item) {
  var labels = "";
  if (item.labels && item.labels.length) {
    labels = '<div class="ws-labels">';
    for (var i = 0; i < item.labels.length; i++) {
      labels += '<span class="ws-label">' + escapeHtml(item.labels[i]) + '</span>';
    }
    labels += '</div>';
  }
  var pinIcon = item.pinned ? "pin-off" : "pin";
  var pinTitle = item.pinned ? "Unpin" : "Pin to session";
  var typeIcon = item.type === "pr" ? "git-pull-request" : "circle-dot";
  var numLabel = (item.type === "pr" ? "PR #" : "#") + item.number;
  var titleText = item.title ? numLabel + " · " + item.title : numLabel;
  var links = item.previewUrl
    ? '<div class="ws-linkrow">' +
      linkBtn(item.previewUrl, "external-link", "Preview") + '</div>'
    : "";
  var unresolved = item.unresolved
    ? '<div class="ws-item-note">Details unavailable. Open on GitHub.</div>'
    : "";
  return '<div class="ws-item"><div class="ws-item-head">' +
    '<a class="ws-item-title" href="' + escapeHtml(item.url) +
    '" target="_blank" rel="noopener" title="' + escapeHtml(titleText) +
    '"><i data-lucide="' + typeIcon + '"></i>' + escapeHtml(titleText) + '</a>' +
    stateChip(item.state) +
    '<button class="ws-pin-btn" data-pin="' + escapeHtml(item.slug || "") +
    '#' + item.number + '" data-pinned="' + (item.pinned ? "1" : "0") +
    '" title="' + pinTitle + '"><i data-lucide="' + pinIcon +
    '"></i></button></div>' + labels + unresolved + links +
    mediaThumbsHtml(item.media) + '</div>';
}

export function workspaceSummaryHtml(state) {
  var repoName = state.repo ? state.repo.slug : "Local project";
  var title = state.repo
    ? '<a href="' + escapeHtml(state.repo.url) +
      '" target="_blank" rel="noopener">' + escapeHtml(repoName) + '</a>'
    : escapeHtml(repoName);
  var branch = state.branch
    ? '<span class="ws-context-branch"><i data-lucide="git-branch"></i><code>' +
      escapeHtml(state.branch) + '</code></span>'
    : "";
  var worktree = state.worktree && state.worktree.isWorktree
    ? '<span class="ws-chip ws-chip-wt">worktree</span>'
    : "";
  var links = "";
  if (state.board) links += linkBtn(state.board, "kanban", "Board");
  if (state.pr) {
    links += linkBtn(state.pr.url, "git-pull-request", "PR #" + state.pr.number);
    if (state.pr.previewUrl) {
      links += linkBtn(state.pr.previewUrl, "external-link", "Preview");
    }
  }
  var note = "";
  if (state.worktree && state.worktree.active) {
    note = '<div class="ws-note"><i data-lucide="git-branch"></i><span>' +
      'This session is bound to its worktree' +
      (state.worktree.mainBranch
        ? '; the main checkout is on <code>' +
          escapeHtml(state.worktree.mainBranch) + '</code>'
        : '') + '.</span></div>';
  }
  return workspaceGroupStart("workspace-context", "Workspace", "folder-git-2", "ws-context-card") +
    '<div class="ws-context-name">' + title + '</div>' +
    '<div class="ws-context-meta">' + branch + worktree + '</div>' +
    note + (links ? '<div class="ws-linkrow">' + links + '</div>' : "") +
    workspaceGroupEnd();
}

export function devSectionHtml(state) {
  var dev = state.dev;
  if (!dev) {
    return workspaceGroupStart("workspace-environment", "Local environment", "server-off", "ws-environment", "ws-dev-section", "Unavailable") +
      '<div>' +
      '<div class="ws-empty-callout">No runnable development script is available for this project.</div>' +
      '</div>' + workspaceGroupEnd();
  }
  var status = dev.status || "stopped";
  var external = status === "external";
  var isUp = status === "running" || external;
  var isStarting = status === "starting";
  var dotCls = isUp ? "ws-dot-on" : isStarting ? "ws-dot-warn" : "ws-dot-off";
  var title = isUp
    ? "Running on :" + escapeHtml(String(dev.port || "—"))
    : isStarting
      ? "Starting on :" + escapeHtml(String(dev.port || "—"))
      : "Development server is stopped";
  var detail = external
    ? "Detected from chat, a terminal, or another tool"
    : isUp
      ? "Managed by this Workspace"
      : escapeHtml(dev.command || dev.script || "Development command");
  var statusLabel = external ? "Detected" : isStarting ? "Starting" : isUp ? "Running" : "Stopped";
  var control = "";
  if (external) {
    control = '<span class="ws-env-managed">Managed outside Workspace</span>';
  } else if (status === "stopped") {
    var portHint = dev.port ? ' on :' + escapeHtml(String(dev.port)) : '';
    control = '<button class="ws-devbtn ws-dev-start" data-dev="start">' +
      '<i data-lucide="play"></i>Start server' + portHint + '</button>';
  } else {
    control = '<div class="ws-devbtns">' +
      '<button class="ws-devbtn ws-dev-stop" data-dev="stop">' +
      '<i data-lucide="square"></i>Stop</button>' +
      '<button class="ws-devbtn ws-dev-restart" data-dev="restart">' +
      '<i data-lucide="refresh-cw"></i>Restart</button></div>';
  }
  var localLink = dev.localUrl && isUp
    ? linkBtn(dev.localUrl, "arrow-up-right", dev.localUrl, "ws-env-link")
    : '<span class="ws-env-url">' + escapeHtml(dev.localUrl || "") + '</span>';
  var tailscaleLink = dev.tailscaleUrl && isUp
    ? linkBtn(dev.tailscaleUrl, "network",
      "Tailscale · " + dev.tailscaleUrl.replace(/^https?:\/\//, ""),
      "ws-env-link ws-env-tailscale")
    : dev.tailscaleUrl
      ? '<span class="ws-env-url ws-env-tailscale"><i data-lucide="network"></i>' +
        'Tailscale · ' + escapeHtml(dev.tailscaleUrl.replace(/^https?:\/\//, "")) + '</span>'
      : "";
  var branch = dev.branch
    ? '<span class="ws-env-branch"><i data-lucide="git-branch"></i><code>' +
      escapeHtml(dev.branch) + '</code></span>'
    : "";
  return workspaceGroupStart("workspace-environment", "Local environment", "monitor-up", "ws-environment ws-environment-" + status, "ws-dev-section", statusLabel) +
    '<div>' +
    '<div class="ws-env-head"><div class="ws-env-beacon"><span class="ws-dot ' +
    dotCls + '"></span><i data-lucide="monitor-up"></i></div>' +
    '<div class="ws-env-copy"><div class="ws-env-eyebrow">Local environment</div>' +
    '<div class="ws-env-title">' + title + '</div>' +
    '<div class="ws-env-detail">' + detail + '</div></div>' +
    '<span class="ws-env-state">' + statusLabel + '</span></div>' +
    '<div class="ws-env-meta">' + branch +
    '<span class="ws-env-command"><i data-lucide="terminal"></i><code>' +
    escapeHtml(dev.command || dev.script || "") + '</code></span></div>' +
    '<div class="ws-env-actions"><div class="ws-env-destination">' +
    localLink + tailscaleLink + '</div>' + control + '</div>' +
    (isUp ? liveUiControlsHtml(dev) : '') + '</div>' + workspaceGroupEnd();
}

export function linkedItemsHtml(state) {
  var content = "";
  if (state.items && state.items.length) {
    for (var i = 0; i < state.items.length; i++) {
      content += itemCardHtml(state.items[i]);
    }
    if (state.truncatedItems) {
      content += '<div class="ws-empty-sm">+' + state.truncatedItems +
        ' more not expanded</div>';
    }
  } else if (state.partial) {
    content = '<div class="ws-empty-callout">Loading linked work…</div>';
  } else {
    content = '<div class="ws-empty-callout"><i data-lucide="link-2"></i>' +
      '<span>No linked work yet. Mention an issue in chat or add one below.</span></div>';
  }
  return workspaceGroupStart("workspace-linked-work", "Linked work", "list-tree") +
    content + '<div class="ws-add"><input type="text" id="ws-add-input" ' +
    'placeholder="Issue number or GitHub URL" spellcheck="false">' +
    '<button class="ws-addbtn" id="ws-add-btn" title="Link issue">' +
    '<i data-lucide="plus"></i></button></div>' + workspaceGroupEnd();
}
