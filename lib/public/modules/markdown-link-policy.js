function escapeAttribute(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function schemeLessWebUrl(value) {
  return /^(?:www\.|localhost(?::\d+)?(?:[/?#]|$)|(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:[/?#]|$)|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$))/i.test(value);
}

function externalUrl(value) {
  if (value.indexOf("//") === 0) return "https:" + value;
  if (/^https?:\/\//i.test(value)) return value;
  if (!schemeLessWebUrl(value)) return null;
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return "http://" + value;
  }
  return "https://" + value;
}

function localFileReference(value) {
  var filePath = value;
  var line = null;
  var column = null;
  var locationMatch = value.match(/^(.*?):(\d+)(?::(\d+))?$/);
  if (locationMatch) {
    filePath = locationMatch[1];
    line = locationMatch[2];
    column = locationMatch[3] || null;
  }
  return { filePath: filePath, line: line, column: column };
}

function titleAttribute(title) {
  return title ? ' title="' + escapeAttribute(title) + '"' : "";
}

export function renderMarkdownLink(link) {
  link = link || {};
  var rawHref = String(link.href || "").trim();
  var text = String(link.text || "");
  var titleAttr = titleAttribute(link.title);
  var webUrl = externalUrl(rawHref);
  if (webUrl) {
    return '<a href="' + escapeAttribute(webUrl) + '"' + titleAttr +
      ' target="_blank" rel="noopener noreferrer">' + text + '</a>';
  }
  if (/^(?:mailto|tel):/i.test(rawHref)) {
    return '<a href="' + escapeAttribute(rawHref) + '"' + titleAttr + '>' + text + '</a>';
  }
  if (rawHref.indexOf("#") === 0) {
    return '<a href="' + escapeAttribute(rawHref) + '"' + titleAttr + '>' + text + '</a>';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawHref) && !/^[a-z]:[\\/]/i.test(rawHref)) {
    return '<span class="markdown-link-blocked"' + titleAttr + '>' + text + '</span>';
  }
  var file = localFileReference(rawHref);
  var fileAttrs = ' data-clay-file-path="' + escapeAttribute(file.filePath) + '"';
  if (file.line) fileAttrs += ' data-clay-file-line="' + escapeAttribute(file.line) + '"';
  if (file.column) fileAttrs += ' data-clay-file-column="' + escapeAttribute(file.column) + '"';
  return '<a href="#"' + fileAttrs + titleAttr + '>' + text + '</a>';
}

export function decodeMarkdownFilePath(value) {
  try {
    return decodeURI(String(value || ""));
  } catch (error) {
    return String(value || "");
  }
}

export var MARKDOWN_SANITIZE_OPTIONS = Object.freeze({
  ADD_ATTR: ["target", "data-clay-file-path", "data-clay-file-line", "data-clay-file-column"],
});
