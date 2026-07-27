var test = require("node:test");
var assert = require("node:assert");
var resolveUnmanagedDevStatus =
  require("../lib/project-workspace-dev-discovery").resolveUnmanagedDevStatus;

function payload(overrides) {
  return Object.assign({
    running: false,
    portLive: false,
    external: false,
    status: "stopped",
    port: null,
  }, overrides || {});
}

test("detects a configured dev server started outside Workspace", function (_, done) {
  resolveUnmanagedDevStatus({
    det: { basePort: 3000 },
    ownPorts: [],
    payload: payload,
    probePort: function (port, cb) {
      assert.strictEqual(port, 3000);
      cb(true);
    },
    findFreePort: function () {
      assert.fail("a live configured port must not be replaced");
    },
  }, function (status) {
    assert.deepStrictEqual(status, {
      running: true,
      portLive: true,
      external: true,
      status: "external",
      port: 3000,
    });
    done();
  });
});

test("keeps a Clay-owned port assigned to its existing worktree", function (_, done) {
  resolveUnmanagedDevStatus({
    det: { basePort: 3000 },
    ownPorts: [3000],
    payload: payload,
    probePort: function () {
      assert.fail("owned ports do not need an external probe");
    },
    findFreePort: function (basePort, ownPorts, cb) {
      assert.strictEqual(basePort, 3000);
      assert.deepStrictEqual(ownPorts, [3000]);
      cb(3001);
    },
  }, function (status) {
    assert.deepStrictEqual(status, payload({ port: 3001 }));
    done();
  });
});

test("previews the next free port when no external server is running", function (_, done) {
  resolveUnmanagedDevStatus({
    det: { basePort: 3000 },
    ownPorts: [],
    payload: payload,
    probePort: function (port, cb) { cb(false); },
    findFreePort: function (basePort, ownPorts, cb) { cb(3000); },
  }, function (status) {
    assert.deepStrictEqual(status, payload({ port: 3000 }));
    done();
  });
});
