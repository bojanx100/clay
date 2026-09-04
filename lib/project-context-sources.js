var fs = require("fs");
var path = require("path");
var config = require("./config");

var contextSourcesDir = path.join(config.CONFIG_DIR, "context-sources");

function loadContextSources(slug, sessionId) {
  try {
    var key = sessionId ? slug + "--" + sessionId : slug;
    var filePath = path.join(contextSourcesDir, key + ".json");
    var data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data.active || [];
  } catch (e) {
    return [];
  }
}

function saveContextSources(slug, sessionId, activeIds) {
  try {
    if (!fs.existsSync(contextSourcesDir)) {
      fs.mkdirSync(contextSourcesDir, { recursive: true });
    }
    var key = sessionId ? slug + "--" + sessionId : slug;
    var filePath = path.join(contextSourcesDir, key + ".json");
    fs.writeFileSync(filePath, JSON.stringify({ active: activeIds }), "utf8");
  } catch (e) {
    console.error("[context-sources] Failed to save:", e.message);
  }
}

module.exports = {
  loadContextSources: loadContextSources,
  saveContextSources: saveContextSources,
};
