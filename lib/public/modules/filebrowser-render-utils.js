export function mapExtToLanguage(ext) {
  var map = {
    js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    css: "css", html: "xml", xml: "xml", json: "json", yaml: "yaml",
    yml: "yaml", md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
    sql: "sql", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
    cs: "csharp", swift: "swift", kt: "kotlin", vue: "xml", svelte: "xml"
  };
  return map[ext] || null;
}

export function getLanguageForPath(filePath) {
  if (!filePath) return null;
  var ext = filePath.split(".").pop().toLowerCase();
  return mapExtToLanguage(ext);
}

export function renderCodeWithLineNumbers(bodyEl, content, ext) {
  var lang = mapExtToLanguage(ext);
  var lines = content.split("\n");
  var lineCount = lines.length;

  var viewer = document.createElement("div");
  viewer.className = "file-viewer-code";

  var gutter = document.createElement("pre");
  gutter.className = "file-viewer-gutter";
  var nums = [];
  for (var i = 1; i <= lineCount; i++) nums.push(i);
  gutter.textContent = nums.join("\n");

  var codeWrap = document.createElement("pre");
  codeWrap.className = "file-viewer-code-content";
  var codeEl = document.createElement("code");
  if (lang) codeEl.className = "language-" + lang;
  codeEl.textContent = content;
  codeWrap.appendChild(codeEl);

  viewer.appendChild(gutter);
  viewer.appendChild(codeWrap);

  bodyEl.innerHTML = "";
  bodyEl.appendChild(viewer);

  if (typeof hljs !== "undefined" && lang) {
    hljs.highlightElement(codeEl);
  }
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}
