var fs = require("fs");
var path = require("path");

function fileFor(stateDir) { return path.join(stateDir, ".preview-sync.lock"); }

function assertUnlocked(stateDir) {
  if (fs.existsSync(fileFor(stateDir))) {
    throw new Error("A preview snapshot is being prepared. Wait for the sync to finish before starting Clay.");
  }
}

function withLock(stateDir, callback) {
  var file = fileFor(stateDir);
  var fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return callback();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(file);
  }
}

module.exports = { assertUnlocked: assertUnlocked, withLock: withLock };
