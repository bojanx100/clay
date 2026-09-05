var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var source = fs.readFileSync(path.join(__dirname, "../bin/cli.js"), "utf8");
var start = source.indexOf("function showServerStarted(");
var end = source.indexOf("\n// ==============================", start);

function run(stdin) {
  var calls = [];
  var context = {
    process: { stdin: stdin },
    console: { log: function () {} },
    showMainMenu: function (config) {
      stdin.setRawMode(true);
      calls.push(config.port);
    }
  };
  vm.runInNewContext(source.slice(start, end), context);
  context.showServerStarted({ port: 7292 }, "localhost");
  return calls;
}

test("background dev startup stays alive without a terminal menu", function () {
  assert.deepEqual(run({}), []);
});

test("interactive startup still opens the management menu", function () {
  assert.deepEqual(run({ isTTY: true, setRawMode: function () {} }), [7292]);
});
