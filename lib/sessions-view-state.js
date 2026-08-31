var fs = require("fs");
var path = require("path");

var FILE_NAME = ".last-viewed.json";

function createSessionViewState(sessionsDir) {
  var filePath = path.join(sessionsDir, FILE_NAME);
  var values = Object.create(null);

  try {
    var parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed && parsed.version === 1 && parsed.sessions &&
        typeof parsed.sessions === "object") {
      values = Object.assign(Object.create(null), parsed.sessions);
    }
  } catch (e) {}

  function get(storageId, fallback) {
    var value = storageId && values[storageId];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function persist(storageId, lastViewedAt) {
    if (!storageId || typeof lastViewedAt !== "number" || !Number.isFinite(lastViewedAt)) {
      return false;
    }
    if (values[storageId] === lastViewedAt) return true;
    values[storageId] = lastViewedAt;
    var tmpPath = filePath + ".tmp." + process.pid;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, sessions: values }) + "\n", {
        mode: 0o600,
      });
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (unlinkErr) {}
      return false;
    }
  }

  return {
    get: get,
    persist: persist,
  };
}

module.exports = {
  createSessionViewState: createSessionViewState,
};
