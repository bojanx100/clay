import { iconHtml, refreshIcons } from './icons.js';
import { escapeHtml } from './utils.js';
import { closeSidebar } from './sidebar.js';
import { getFileIconSvg, getFolderIconSvg } from './fileicons.js';

export function renderFilteredFileTree(opts) {
  var container = opts.container;
  var tree = opts.tree;
  var depth = opts.depth || 0;
  var query = opts.query || "";
  var keys = Object.keys(tree);
  var dirs = [];
  var files = [];
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === "_entry") continue;
    var node = tree[keys[i]];
    var entry = node._entry;
    if (entry && entry.type === "file") {
      files.push(keys[i]);
    } else {
      dirs.push(keys[i]);
    }
  }
  dirs.sort(sortTreeNames);
  files.sort(sortTreeNames);

  var allKeys = dirs.concat(files);
  for (var k = 0; k < allKeys.length; k++) {
    var name = allKeys[k];
    var childNode = tree[name];
    var childEntry = childNode._entry;
    var isDir = !childEntry || childEntry.type === "dir";
    var row = createTreeRow(depth);
    var nameHtml = highlightMatch(name, query);

    if (childEntry) {
      attachDragPath(row, childEntry.path, opts, false);
    }

    if (isDir) {
      row.className += " expanded";
      row.innerHTML =
        '<span class="file-tree-chevron">' + iconHtml("chevron-right") + '</span>' +
        '<span class="file-tree-icon file-tree-folder-icon"></span>' +
        '<span class="file-tree-name">' + nameHtml + '</span>';
      renderFolderIcon(row, name, true);

      var childContainer = document.createElement("div");
      childContainer.className = "file-tree-children";
      attachFilteredDirToggle(row, childContainer, name);

      container.appendChild(row);
      container.appendChild(childContainer);
      renderFilteredFileTree(Object.assign({}, opts, {
        container: childContainer,
        tree: childNode,
        depth: depth + 1
      }));
    } else {
      row.innerHTML =
        '<span class="file-tree-spacer"></span>' +
        '<span class="file-tree-icon">' + getFileIconSvg(name) + '</span>' +
        '<span class="file-tree-name">' + nameHtml + '</span>';
      attachFileOpen(row, childEntry.path, opts);
      container.appendChild(row);
    }
  }
}

export function renderFileTreeEntries(opts) {
  var container = opts.container;
  var entries = opts.entries || [];
  var depth = opts.depth || 0;
  var sorted = sortEntries(entries);

  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    var row = createTreeRow(depth);
    attachDragPath(row, entry.path, opts, true);

    if (entry.type === "dir") {
      row.innerHTML =
        '<span class="file-tree-chevron">' + iconHtml("chevron-right") + '</span>' +
        '<span class="file-tree-icon file-tree-folder-icon"></span>' +
        '<span class="file-tree-name">' + escapeHtml(entry.name) + '</span>';
      renderFolderIcon(row, entry.name, false);

      var childContainer = document.createElement("div");
      childContainer.className = "file-tree-children hidden";
      childContainer.dataset.parentPath = entry.path;
      attachDirToggle(row, childContainer, entry, opts);

      container.appendChild(row);
      container.appendChild(childContainer);
    } else {
      row.innerHTML =
        '<span class="file-tree-spacer"></span>' +
        '<span class="file-tree-icon">' + getFileIconSvg(entry.name) + '</span>' +
        '<span class="file-tree-name">' + escapeHtml(entry.name) + '</span>';
      attachFileOpen(row, entry.path, opts);
      container.appendChild(row);
    }
  }
}

export function restoreExpandedFileTree(opts) {
  var fileTreeEl = opts.fileTreeEl;
  var treeData = opts.treeData || {};
  var expandedSet = opts.expandedSet || {};
  var currentFilePath = opts.currentFilePath;
  var fileViewerEl = opts.fileViewerEl;
  var containers = fileTreeEl.querySelectorAll(".file-tree-children");
  for (var i = 0; i < containers.length; i++) {
    var p = containers[i].dataset.parentPath;
    if (p && expandedSet[p] && treeData[p] && treeData[p].loaded) {
      containers[i].classList.remove("hidden");
      var row = containers[i].previousElementSibling;
      if (row) row.classList.add("expanded");
      containers[i].innerHTML = "";
      renderFileTreeEntries(Object.assign({}, opts, {
        container: containers[i],
        entries: treeData[p].children,
        depth: p.split("/").length
      }));
    }
  }
  if (currentFilePath && !fileViewerEl.classList.contains("hidden")) {
    var items = fileTreeEl.querySelectorAll(".file-tree-item");
    for (var j = 0; j < items.length; j++) {
      var nameEl = items[j].querySelector(".file-tree-name");
      if (nameEl && nameEl.textContent === currentFilePath.split("/").pop()) {
        items[j].classList.add("active");
        break;
      }
    }
  }
  refreshIcons();
}

function createTreeRow(depth) {
  var row = document.createElement("div");
  row.className = "file-tree-item";
  row.style.paddingLeft = (8 + depth * 16) + "px";
  return row;
}

function attachDragPath(row, path, opts, showHint) {
  row.draggable = true;
  row.dataset.path = path;
  row.addEventListener("dragstart", function (e) {
    var cwd = opts.cwd || "";
    var rel = this.dataset.path;
    var abs = cwd ? cwd.replace(/\/$/, "") + "/" + rel : rel;
    e.dataTransfer.setData("text/plain", abs);
    e.dataTransfer.effectAllowed = "copy";
    if (showHint && typeof opts.showDropHint === "function") {
      opts.showDropHint();
    }
  });
}

function attachFileOpen(row, filePath, opts) {
  row.addEventListener("click", function (e) {
    e.stopPropagation();
    var prev = opts.fileTreeEl.querySelector(".file-tree-item.active");
    if (prev) prev.classList.remove("active");
    row.classList.add("active");
    opts.requestFileContent(filePath);
    if (window.innerWidth <= 768) {
      closeSidebar();
    }
  });
}

function attachFilteredDirToggle(row, childContainer, folderName) {
  row.addEventListener("click", function (e) {
    e.stopPropagation();
    var isExpanded = row.classList.contains("expanded");
    row.classList.toggle("expanded");
    childContainer.classList.toggle("hidden", isExpanded);
    var folderIconEl = row.querySelector(".file-tree-folder-icon");
    if (folderIconEl) {
      getFolderIconSvg(folderName, !isExpanded, function (svg) { folderIconEl.innerHTML = svg; });
    }
  });
}

function attachDirToggle(row, childContainer, entry, opts) {
  row.addEventListener("click", function (e) {
    e.stopPropagation();
    var isExpanded = row.classList.contains("expanded");
    if (isExpanded) {
      row.classList.remove("expanded");
      childContainer.classList.add("hidden");
    } else {
      row.classList.add("expanded");
      childContainer.classList.remove("hidden");
      if (!opts.treeData[entry.path] || !opts.treeData[entry.path].loaded) {
        childContainer.innerHTML = '<div class="file-tree-loading">Loading...</div>';
        opts.requestDirectory(entry.path);
      } else {
        childContainer.innerHTML = "";
        renderFileTreeEntries(Object.assign({}, opts, {
          container: childContainer,
          entries: opts.treeData[entry.path].children,
          depth: entry.path.split("/").length
        }));
        refreshIcons();
      }
    }
    var folderIconEl = row.querySelector(".file-tree-folder-icon");
    if (folderIconEl) {
      getFolderIconSvg(entry.name, !isExpanded, function (svg) {
        folderIconEl.innerHTML = svg;
      });
    }
  });
}

function renderFolderIcon(row, name, open) {
  var iconEl = row.querySelector(".file-tree-folder-icon");
  getFolderIconSvg(name, open, function (svg) {
    iconEl.innerHTML = svg;
  });
}

function sortEntries(entries) {
  return entries.slice().sort(function (a, b) {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return sortTreeNames(a.name, b.name);
  });
}

function sortTreeNames(a, b) {
  var aH = a.charAt(0) === ".";
  var bH = b.charAt(0) === ".";
  if (aH !== bH) return aH ? 1 : -1;
  return a.localeCompare(b);
}

function highlightMatch(text, query) {
  var lower = text.toLowerCase();
  var idx = lower.indexOf(query);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.substring(0, idx)) +
    '<mark>' + escapeHtml(text.substring(idx, idx + query.length)) + '</mark>' +
    escapeHtml(text.substring(idx + query.length));
}
