var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function moduleUrl(name) {
  return pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", name)).href;
}

test("Workspace group preferences hydrate from the server and save a toggle", async function () {
  var requests = [];
  var oldFetch = globalThis.fetch;
  globalThis.fetch = function (url, options) {
    requests.push({ url: url, options: options });
    if (!options || options.method !== "PUT") {
      return Promise.resolve({ ok: true, json: function () {
        return Promise.resolve({ groups: { attention: true, "attention-project:clay": true } });
      } });
    }
    return Promise.resolve({ ok: true, json: function () { return Promise.resolve({}); } });
  };
  try {
    var store = await import(moduleUrl("store.js"));
    var groups = await import(moduleUrl("workspace-group-collapse.js") + "?workspace-group-test=" + Date.now());
    store.store.set({ workspaceGroupStates: {} });
    groups.initWorkspaceGroupPreferences();
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    assert.deepEqual(store.store.get("workspaceGroupStates"), {
      attention: true, "attention-project:clay": true,
    });
    assert.equal(groups.isWorkspaceGroupCollapsed("attention"), true);
    assert.equal(groups.isWorkspaceGroupCollapsed("new-group"), false,
      "groups without a stored collapsed key remain expanded");

    groups.toggleWorkspaceGroup("attention");
    assert.equal(groups.isWorkspaceGroupCollapsed("attention"), false);
    await new Promise(function (resolve) { setTimeout(resolve, 300); });
    var write = requests.find(function (request) { return request.options && request.options.method === "PUT"; });
    assert.ok(write, "a toggle is persisted through the server preference endpoint");
    assert.deepEqual(JSON.parse(write.options.body), {
      groups: { "attention-project:clay": true },
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
