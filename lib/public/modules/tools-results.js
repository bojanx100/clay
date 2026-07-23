import { iconHtml, refreshIcons } from './icons.js';
import { renderUnifiedDiff, renderSplitDiff, renderPatchDiff, reconstructPatchSources } from './diff.js';
import { openFile } from './filebrowser.js';

var ctx;
var deps = {};
var LIVE_OUTPUT_MAX_CHARS = 20000;
var IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);

export function initToolResultTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function tools() {
  return deps.getTools ? deps.getTools() : {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

function findToolGroup(groupId) {
  return deps.findToolGroup ? deps.findToolGroup(groupId) : null;
}

function updateToolGroupHeader(group) {
  if (deps.updateToolGroupHeader) deps.updateToolGroupHeader(group);
}

function toolResultActivityText(content, isError, images) {
  if (isError) return "Failed";
  if ((content != null && String(content).trim().length > 0) || (images && images.length > 0)) {
    return "Completed";
  }
  return "Completed with no output";
}

function buildDiffChrome(filePath, linkOldStr, linkNewStr, makeUnified, makeSplit) {
  var wrapper = document.createElement("div");
  wrapper.className = "edit-diff";

  var header = document.createElement("div");
  header.className = "edit-diff-header";

  var pathSpan = document.createElement("span");
  pathSpan.className = "edit-diff-path edit-diff-path-link";
  pathSpan.textContent = filePath || "";
  if (filePath) {
    (function (fp, os, ns) {
      pathSpan.addEventListener("click", function (e) {
        e.stopPropagation();
        openFile(fp, { diff: { oldStr: os || "", newStr: ns || "" } });
      });
    })(filePath, linkOldStr, linkNewStr);
  }
  header.appendChild(pathSpan);

  var isMobile = "ontouchstart" in window;
  var isSplit = false;

  var unifiedBtn = document.createElement("button");
  unifiedBtn.className = "edit-diff-toggle active";
  unifiedBtn.innerHTML = iconHtml("list");
  unifiedBtn.title = "Unified view";

  var splitBtn = document.createElement("button");
  splitBtn.className = "edit-diff-toggle";
  splitBtn.innerHTML = iconHtml("columns-2");
  splitBtn.title = "Split view";

  var toggleWrap = document.createElement("span");
  toggleWrap.className = "edit-diff-toggles";
  if (isMobile) toggleWrap.style.display = "none";
  toggleWrap.appendChild(unifiedBtn);
  toggleWrap.appendChild(splitBtn);
  header.appendChild(toggleWrap);

  wrapper.appendChild(header);

  var currentBody = makeUnified();
  wrapper.appendChild(currentBody);

  unifiedBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (!isSplit) return;
    isSplit = false;
    unifiedBtn.classList.add("active");
    splitBtn.classList.remove("active");
    wrapper.removeChild(currentBody);
    currentBody = makeUnified();
    wrapper.appendChild(currentBody);
    refreshIcons();
  });

  splitBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (isSplit) return;
    isSplit = true;
    splitBtn.classList.add("active");
    unifiedBtn.classList.remove("active");
    wrapper.removeChild(currentBody);
    currentBody = makeSplit();
    wrapper.appendChild(currentBody);
    refreshIcons();
  });

  return wrapper;
}

function renderEditDiff(oldStr, newStr, filePath) {
  var lang = getLanguageFromPath(filePath);
  return buildDiffChrome(
    filePath,
    oldStr,
    newStr,
    function () { return renderUnifiedDiff(oldStr, newStr, lang); },
    function () { return renderSplitDiff(oldStr, newStr, lang); }
  );
}

function renderPatchDiffBlock(patchText, filePath) {
  var lang = getLanguageFromPath(filePath);
  var sources = reconstructPatchSources(patchText);
  return buildDiffChrome(
    filePath,
    sources.oldStr,
    sources.newStr,
    function () { return renderPatchDiff(patchText, lang); },
    function () { return renderSplitDiff(sources.oldStr, sources.newStr, lang); }
  );
}

function isDiffContent(text) {
  var lines = text.split("\n");
  var hasHunkHeader = false;
  var hasPatchLine = false;
  for (var i = 0; i < Math.min(lines.length, 20); i++) {
    var l = lines[i];
    if (l.startsWith("@@")) hasHunkHeader = true;
    if (l.startsWith("---") || l.startsWith("+++")) hasPatchLine = true;
    if ((l.startsWith("+") && !l.startsWith("+++")) || (l.startsWith("-") && !l.startsWith("---"))) {
      hasPatchLine = true;
    }
  }
  return (hasHunkHeader && hasPatchLine) || hasPatchLine;
}

function getLanguageFromPath(filePath) {
  if (!filePath) return null;
  var parts = filePath.split("/");
  var filename = parts[parts.length - 1].toLowerCase();
  var dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1 || dotIdx === filename.length - 1) return null;
  var ext = filename.substring(dotIdx + 1);
  var map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", mts: "typescript",
    py: "python", rb: "ruby", rs: "rust", go: "go",
    java: "java", kt: "kotlin", kts: "kotlin",
    cs: "csharp", cpp: "cpp", cc: "cpp", c: "c", h: "c", hpp: "cpp",
    css: "css", scss: "scss", less: "less",
    html: "xml", htm: "xml", xml: "xml", svg: "xml",
    json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", swift: "swift", php: "php",
    toml: "ini", ini: "ini", conf: "ini",
    lua: "lua", r: "r", pl: "perl",
    ex: "elixir", exs: "elixir",
    erl: "erlang", hs: "haskell",
    graphql: "graphql", gql: "graphql",
  };
  return map[ext] || null;
}

function parseLineNumberedContent(text) {
  var lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) return null;

  var pattern = /^\s*(\d+)[→\t](.*)$/;
  var checkCount = Math.min(lines.length, 5);
  var matchCount = 0;
  for (var i = 0; i < checkCount; i++) {
    if (pattern.test(lines[i])) matchCount++;
  }
  if (matchCount < Math.ceil(checkCount * 0.6)) return null;

  var numbers = [];
  var code = [];
  for (var j = 0; j < lines.length; j++) {
    var m = lines[j].match(pattern);
    if (m) {
      numbers.push(m[1]);
      code.push(m[2]);
    } else {
      numbers.push("");
      code.push(lines[j]);
    }
  }
  return { numbers: numbers, code: code };
}

function isImagePath(filePath) {
  if (!filePath) return false;
  var dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return IMAGE_EXTS.has(filePath.substring(dotIdx).toLowerCase());
}

export function updateToolResult(id, content, isError, images) {
  var tool = tools()[id];
  if (!tool) return;

  tool.hasResult = true;

  var liveOut = tool.el.querySelector(".tool-live-output");
  if (liveOut) liveOut.remove();

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = toolResultActivityText(content, isError, images);

  var resultBlock = document.createElement("div");
  var displayContent = content || "(no output)";
  displayContent = displayContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  if (displayContent.length > 10000) displayContent = displayContent.substring(0, 10000) + "\n... (truncated)";

  var hasEditDiff = !isError && tool.name === "Edit" && tool.input && tool.input.old_string && tool.input.new_string;
  var expandByDefault = hasEditDiff || (!isError && tool.name === "Edit" && isDiffContent(displayContent));
  if (expandByDefault) {
    resultBlock.className = "tool-result-block";
    tool.el.classList.add("expanded");
  } else {
    resultBlock.className = "tool-result-block collapsed";
  }

  renderToolResultContent(resultBlock, tool, displayContent, isError, images, hasEditDiff);
  tool.el.appendChild(resultBlock);

  tool.el.querySelector(".tool-header").addEventListener("click", function () {
    resultBlock.classList.toggle("collapsed");
    tool.el.classList.toggle("expanded");
  });

  markToolDone(id, isError);
  maybeScrollToBottom();
}

function renderToolResultContent(resultBlock, tool, displayContent, isError, images, hasEditDiff) {
  if (hasEditDiff) {
    resultBlock.appendChild(renderEditDiff(tool.input.old_string, tool.input.new_string, tool.input.file_path));
  } else if (!isError && isDiffContent(displayContent)) {
    renderPatchToolResult(resultBlock, tool, displayContent);
  } else if (!isError && images && images.length > 0) {
    renderImageToolResult(resultBlock, tool, images);
    if (displayContent) renderPlainToolResult(resultBlock, displayContent, false);
  } else if (!isError && tool.name === "Read" && tool.input && tool.input.file_path && isImagePath(tool.input.file_path)) {
    renderImageToolResult(resultBlock, tool, images);
  } else if (!isError && tool.name === "Read" && tool.input && tool.input.file_path) {
    renderReadToolResult(resultBlock, tool, displayContent);
  } else {
    renderPlainToolResult(resultBlock, displayContent || "(no output)", isError);
  }
}

function renderPlainToolResult(resultBlock, displayContent, isError) {
  var pre = document.createElement("pre");
  if (isError) pre.className = "is-error";
  pre.textContent = displayContent;
  resultBlock.appendChild(pre);
}

function renderPatchToolResult(resultBlock, tool, displayContent) {
  var patchFilePath = tool.input && tool.input.file_path ? tool.input.file_path : null;
  if (patchFilePath) {
    resultBlock.appendChild(renderPatchDiffBlock(displayContent, patchFilePath));
  } else {
    resultBlock.appendChild(renderPatchDiff(displayContent, null));
  }
}

function renderImageToolResult(resultBlock, tool, images) {
  if (images && images.length > 0) {
    for (var imageIndex = 0; imageIndex < images.length; imageIndex++) {
      var image = images[imageIndex];
      if (!image || (!image.url && (!image.mediaType || !image.data))) continue;
      appendToolResultImage(resultBlock, tool, image.url ||
        ("data:" + image.mediaType + ";base64," + image.data));
    }
  } else {
    appendToolResultImage(resultBlock, tool,
      "api/file?path=" + encodeURIComponent(tool.input.file_path));
  }
  resultBlock.className = "tool-result-block";
  tool.el.classList.add("expanded");
}

function appendToolResultImage(resultBlock, tool, src) {
  var imgWrap = document.createElement("div");
  imgWrap.className = "tool-result-image";
  var img = document.createElement("img");
  img.src = src;
  img.alt = tool.input && tool.input.file_path
    ? tool.input.file_path.split("/").pop()
    : (tool.name || "Generated image");
  img.draggable = false;
  img.addEventListener("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    if (ctx.showImageModal) ctx.showImageModal(this.src);
  });
  imgWrap.appendChild(img);
  resultBlock.appendChild(imgWrap);
}

function renderReadToolResult(resultBlock, tool, displayContent) {
  var parsed = parseLineNumberedContent(displayContent);
  if (!parsed) {
    var pre = document.createElement("pre");
    pre.textContent = displayContent;
    resultBlock.appendChild(pre);
    return;
  }

  var lang = getLanguageFromPath(tool.input.file_path);
  var viewer = document.createElement("div");
  viewer.className = "code-viewer";

  var gutter = document.createElement("pre");
  gutter.className = "code-gutter";
  gutter.textContent = parsed.numbers.join("\n");

  var codeBlock = document.createElement("pre");
  codeBlock.className = "code-content";
  var codeText = parsed.code.join("\n");

  if (lang) {
    try {
      var highlighted = hljs.highlight(codeText, { language: lang });
      var codeEl = document.createElement("code");
      codeEl.className = "hljs language-" + lang;
      codeEl.innerHTML = highlighted.value;
      codeBlock.appendChild(codeEl);
    } catch (e) {
      codeBlock.textContent = codeText;
    }
  } else {
    codeBlock.textContent = codeText;
  }

  viewer.appendChild(gutter);
  viewer.appendChild(codeBlock);
  viewer.addEventListener("scroll", function () {
    gutter.scrollTop = viewer.scrollTop;
    codeBlock.scrollTop = viewer.scrollTop;
  });
  resultBlock.appendChild(viewer);
}

export function appendToolOutput(id, text) {
  var tool = tools()[id];
  if (!tool || !tool.el || !text) return;
  if (tool.done) return;

  var pre = tool.el.querySelector(".tool-live-output");
  if (!pre) {
    pre = document.createElement("pre");
    pre.className = "tool-live-output";
    tool.el.appendChild(pre);
  }
  var next = pre.textContent + text;
  if (next.length > LIVE_OUTPUT_MAX_CHARS) {
    next = "... (earlier output trimmed)\n" + next.substring(next.length - LIVE_OUTPUT_MAX_CHARS);
  }
  pre.textContent = next;
  maybeScrollToBottom();
}

export function markToolDone(id, isError) {
  var tool = tools()[id];
  if (!tool || tool.done) return;

  tool.done = true;
  if (!tool.el) return;

  tool.el.classList.add("done");
  if (isError) tool.el.classList.add("error");

  var icon = tool.el.querySelector(".tool-status-icon");
  if (isError) {
    icon.innerHTML = '<span class="err-icon">' + iconHtml("alert-triangle") + '</span>';
  } else {
    icon.innerHTML = '<span class="check">' + iconHtml("check") + '</span>';
  }
  refreshIcons();

  if (!tool.hasResult) {
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) {
      var current = (subtitleText.textContent || "").trim();
      if (!current || /^(Running|Searching|Executing)\b/i.test(current) || current === "Running...") {
        subtitleText.textContent = isError ? "Failed" : "Stopped";
      }
    }
  }

  if (tool.groupId) {
    var group = findToolGroup(tool.groupId);
    if (group) {
      group.doneCount++;
      if (isError) group.errorCount++;
      updateToolGroupHeader(group);
    }
  }
}

export function markAllToolsDone() {
  var allTools = tools();
  for (var id in allTools) {
    if (allTools.hasOwnProperty(id) && !allTools[id].done) {
      markToolDone(id, false);
    }
  }
}
