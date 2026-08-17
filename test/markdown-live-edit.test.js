var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

async function loadModule() {
  var source = fs.readFileSync(path.join(__dirname, "../lib/public/modules/markdown-live-edit.js"), "utf8");
  var url = "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  return import(url);
}

test("Markdown live edit recognizes Markdown paths from single and multi-file tools", async function () {
  var liveEdit = await loadModule();
  assert.strictEqual(liveEdit.markdownPathFromToolInput({ file_path: "/work/guide.md" }), "/work/guide.md");
  assert.strictEqual(liveEdit.markdownPathFromToolInput({ file_path: "/work/app.js" }), null);
  assert.strictEqual(liveEdit.markdownPathFromToolInput({
    file_paths: ["/work/app.js", "/work/notes.mdx", "/work/readme.md"],
  }), "/work/notes.mdx");
  assert.strictEqual(liveEdit.markdownPathFromToolInput(null), null);
});

test("Markdown block diff keeps stable blocks and exposes replacements", async function () {
  var liveEdit = await loadModule();
  var matches = liveEdit.diffBlockSignatures(
    ["<h1>Title</h1>", "<p>Old copy</p>", "<p>Stable</p>"],
    ["<h1>Title</h1>", "<p>New copy</p>", "<p>Stable</p>"]
  );
  assert.deepStrictEqual(matches, [
    { oldIndex: 0, newIndex: 0 },
    { oldIndex: 2, newIndex: 2 },
  ]);
});

test("change tour gives every changed block a readable stop", async function () {
  var liveEdit = await loadModule();
  assert.strictEqual(liveEdit.changeTourDelay(""), 850);
  assert.ok(liveEdit.changeTourDelay("A substantial changed paragraph ".repeat(20)) > 850);
  assert.strictEqual(liveEdit.changeTourDelay("x".repeat(1000)), 1800);
});

test("message routing opens Markdown only from the explicit MCP presentation event", function () {
  var messages = fs.readFileSync(path.join(__dirname, "../lib/public/modules/app-messages.js"), "utf8");
  var browser = fs.readFileSync(path.join(__dirname, "../lib/public/modules/filebrowser.js"), "utf8");
  var liveEdit = fs.readFileSync(path.join(__dirname, "../lib/public/modules/markdown-live-edit.js"), "utf8");
  assert.match(messages, /case "markdown_edit_present":/);
  assert.match(messages, /presentMarkdownEdit\(msg\)/);
  assert.match(browser, /beginMarkdownPresentation\(msg\.path\)/);
  assert.match(messages, /!store\.get\('replayingHistory'\)/);
  assert.match(browser, /animateMarkdownChange\(markdownEl, previousMarkdown, currentContent, renderMarkdown\)/);
  assert.match(messages, /finishMarkdownTurn\(\)/);
  assert.doesNotMatch(liveEdit, /parseMarkdownEditIntent|cuePattern|turnIntent/);
});
