import { renderUnifiedDiff, renderSplitDiff } from './diff.js';
import { getLanguageForPath, mapExtToLanguage } from './filebrowser-render-utils.js';

export function renderInlineDiffView(opts) {
  var bodyEl = opts.bodyEl;
  var viewerEl = opts.viewerEl;
  var currentContent = opts.currentContent;
  var currentFilePath = opts.currentFilePath;
  var oldStr = opts.oldStr;
  var newStr = opts.newStr;
  var onBack = opts.onBack;

  viewerEl.classList.add("file-viewer-wide");
  if (!currentContent) return;

  var fileBefore = currentContent;
  var fileAfter = currentContent;
  if (newStr && oldStr != null) {
    var pos = currentContent.indexOf(newStr);
    if (pos >= 0) {
      fileBefore = currentContent.substring(0, pos) + oldStr + currentContent.substring(pos + newStr.length);
    }
  }

  var diffLang = getLanguageForPath(currentFilePath);
  var viewMode = "split";

  function render() {
    bodyEl.innerHTML = "";

    var topBar = document.createElement("div");
    topBar.className = "file-history-view-bar";

    var backBtn = document.createElement("button");
    backBtn.className = "file-history-compare-back";
    backBtn.textContent = "Back to file";
    backBtn.addEventListener("click", function () {
      if (typeof onBack === "function") onBack();
    });
    topBar.appendChild(backBtn);

    var toggleWrap = document.createElement("div");
    toggleWrap.className = "file-history-view-toggle";

    var splitBtn = document.createElement("button");
    splitBtn.className = "file-history-toggle-btn" + (viewMode === "split" ? " active" : "");
    splitBtn.textContent = "Split";
    splitBtn.addEventListener("click", function () {
      viewMode = "split";
      render();
    });

    var unifiedBtn = document.createElement("button");
    unifiedBtn.className = "file-history-toggle-btn" + (viewMode === "unified" ? " active" : "");
    unifiedBtn.textContent = "Unified";
    unifiedBtn.addEventListener("click", function () {
      viewMode = "unified";
      render();
    });

    var sourceBtn = document.createElement("button");
    sourceBtn.className = "file-history-toggle-btn" + (viewMode === "source" ? " active" : "");
    sourceBtn.textContent = "Source";
    sourceBtn.addEventListener("click", function () {
      viewMode = "source";
      render();
    });

    toggleWrap.appendChild(splitBtn);
    toggleWrap.appendChild(unifiedBtn);
    toggleWrap.appendChild(sourceBtn);
    topBar.appendChild(toggleWrap);
    bodyEl.appendChild(topBar);

    if (viewMode === "source") {
      viewerEl.classList.remove("file-viewer-wide");
      var sourceWrap = document.createElement("div");
      sourceWrap.className = "file-history-diff-full";
      var ext = currentFilePath ? currentFilePath.split(".").pop().toLowerCase() : "";
      var lang = mapExtToLanguage(ext);
      var pre = document.createElement("pre");
      pre.className = "file-viewer-code-content";
      var codeEl = document.createElement("code");
      if (lang) codeEl.className = "language-" + lang;
      codeEl.textContent = fileAfter;
      pre.appendChild(codeEl);
      sourceWrap.appendChild(pre);
      bodyEl.appendChild(sourceWrap);
      if (typeof hljs !== "undefined" && lang) {
        hljs.highlightElement(codeEl);
      }
    } else {
      viewerEl.classList.add("file-viewer-wide");
      var diffWrap = document.createElement("div");
      diffWrap.className = "file-history-diff-full";

      if (viewMode === "split") {
        diffWrap.appendChild(renderSplitDiff(fileBefore, fileAfter, diffLang));
      } else {
        diffWrap.appendChild(renderUnifiedDiff(fileBefore, fileAfter, diffLang));
      }

      bodyEl.appendChild(diffWrap);

      requestAnimationFrame(function () {
        var firstChange = diffWrap.querySelector(".diff-row-change, .diff-row-add, .diff-row-remove");
        if (firstChange) {
          firstChange.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
    }
  }

  render();
}
