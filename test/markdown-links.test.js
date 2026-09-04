var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

test("markdown links distinguish external URLs from local files", async function () {
  var policy = await import(moduleUrl("markdown-link-policy.js"));
  var external = policy.renderMarkdownLink({ href: "https://example.com/docs", text: "Docs" });
  var schemeLess = policy.renderMarkdownLink({ href: "docs.example.com/start", text: "Start" });
  var local = policy.renderMarkdownLink({ href: "/workspace/app.js:42", text: "app.js" });
  var fragment = policy.renderMarkdownLink({ href: "#details", text: "Details" });
  var blocked = policy.renderMarkdownLink({ href: "javascript:alert(1)", text: "Unsafe" });

  assert.match(external, /href="https:\/\/example\.com\/docs"/);
  assert.match(external, /target="_blank"/);
  assert.match(external, /rel="noopener noreferrer"/);
  assert.match(schemeLess, /href="https:\/\/docs\.example\.com\/start"/);
  assert.match(schemeLess, /target="_blank"/);
  assert.match(local, /href="#"/);
  assert.match(local, /data-clay-file-path="\/workspace\/app\.js"/);
  assert.match(local, /data-clay-file-line="42"/);
  assert.doesNotMatch(local, /target="_blank"/);
  assert.match(fragment, /href="#details"/);
  assert.match(blocked, /^<span class="markdown-link-blocked"/);
  assert.doesNotMatch(blocked, /javascript:/);
  assert.ok(policy.MARKDOWN_SANITIZE_OPTIONS.ADD_ATTR.indexOf("target") !== -1);
  assert.ok(policy.MARKDOWN_SANITIZE_OPTIONS.ADD_ATTR.indexOf("data-clay-file-path") !== -1);
});

test("sanitization preserves new-tab links and local paths use Clay's file viewer", function () {
  var markdown = source("lib/public/modules/markdown.js");
  var rendering = source("lib/public/modules/app-rendering.js");

  assert.match(markdown, /renderMarkdownLink/);
  assert.match(markdown, /MARKDOWN_SANITIZE_OPTIONS/);
  assert.match(markdown, /DOMPurify\.sanitize\(marked\.parse\(normalized\), MARKDOWN_SANITIZE_OPTIONS\)/);
  assert.match(rendering, /openFile\(filePath\)/);
  assert.match(rendering, /initMarkdownLinkNavigation\(\)/);
});
