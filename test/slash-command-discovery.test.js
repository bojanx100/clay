var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

var createSessionManager = require("../lib/sessions").createSessionManager;

test("Clay provider commands stay in server slash catalogs for reconnecting clients", function () {
  var projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-slash-command-"));
  var sm = createSessionManager({ cwd: projectDir, send: function () {} });

  assert.deepStrictEqual(sm.slashCommands, ["provider", "switch"]);

  sm.slashCommands = ["model", "provider"];
  assert.deepStrictEqual(sm.slashCommands, ["provider", "switch", "model"]);

  sm.setSlashCommandsForVendor("claude", ["compact", "switch"]);
  assert.deepStrictEqual(sm.getSlashCommandsForVendor("claude"), ["provider", "switch", "compact"]);
  assert.deepStrictEqual(sm.getSlashCommandsForVendor("codex"), ["provider", "switch"]);
});
