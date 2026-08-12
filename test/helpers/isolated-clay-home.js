var fs = require("fs");
var os = require("os");
var path = require("path");

var isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "clay-test-home-"));
process.env.CLAY_HOME = isolatedHome;

process.on("exit", function () {
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch (e) {}
});

module.exports = isolatedHome;
