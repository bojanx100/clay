var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");

test("rendered Markdown exposes a separate formatting copy action", function () {
  var html = fs.readFileSync(path.join(__dirname, "../lib/public/index.html"), "utf8");
  var fileBrowser = fs.readFileSync(path.join(__dirname, "../lib/public/modules/filebrowser.js"), "utf8");
  assert.match(html, /id="file-viewer-copy-formatted"[^>]*title="Copy Markdown formatting"/);
  assert.match(fileBrowser, /copyMarkdownFormatting\(currentContent\)/);
  assert.match(fileBrowser, /formattedCopyBtn\.classList\.remove\("hidden"\)/);
  assert.match(fileBrowser, /formattedCopyBtn\.classList\.add\("hidden"\)/);
});

test("Markdown formatting copy writes clean semantic clipboard flavors", function () {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/rich-clipboard.js"), "utf8");
  assert.match(source, /"text\/html"/);
  assert.match(source, /"text\/plain"/);
  assert.match(source, /renderMarkdown\(markdown/);
  assert.match(source, /removeAttribute\("class"\)/);
  assert.match(source, /removeAttribute\("style"\)/);
  assert.doesNotMatch(source, /TAG_STYLES|font-size:24px|background:#f5f5f5/);
  assert.match(source, /legacyCopyHtml/);
});
