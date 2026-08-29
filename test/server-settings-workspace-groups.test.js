var test = require("node:test");
var assert = require("node:assert/strict");
var attachSettings = require("../lib/server-settings").attachSettings;

function makeRequest(handler, method, url, body) {
  return new Promise(function (resolve, reject) {
    var dataHandler = null;
    var endHandler = null;
    var req = {
      method: method,
      url: url,
      on: function (event, callback) {
        if (event === "data") dataHandler = callback;
        if (event === "end") endHandler = callback;
      },
    };
    var res = {
      writeHead: function (status) { res.status = status; },
      end: function (value) { resolve({ status: res.status, body: value }); },
    };
    var path = url.split("?")[0];
    if (!handler.handleRequest(req, res, path)) {
      reject(new Error("request was not handled"));
      return;
    }
    if (body !== undefined) {
      dataHandler(body);
      endHandler();
    }
  });
}

test("Workspace group collapse state uses the existing server-backed user preference route", async function () {
  var states = { attention: true };
  var handler = attachSettings({
    users: {
      isMultiUser: function () { return false; },
    },
    mates: {},
    getMultiUserFromReq: function () { return null; },
    projects: [],
    opts: {
      onGetWorkspaceGroupStates: function () { return states; },
      onSetWorkspaceGroupStates: function (next) {
        states = next;
        return { ok: true, groups: next };
      },
    },
    CONFIG_DIR: "/tmp",
  });

  var loaded = await makeRequest(handler, "GET", "/api/user/workspace-group-states");
  assert.equal(loaded.status, 200);
  assert.deepEqual(JSON.parse(loaded.body), { groups: { attention: true } });

  var saved = await makeRequest(handler, "PUT", "/api/user/workspace-group-states", JSON.stringify({
    groups: { attention: true, landed: false },
  }));
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse(saved.body), { ok: true, groups: { attention: true, landed: false } });
  assert.deepEqual(states, { attention: true, landed: false });
});
