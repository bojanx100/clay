var test = require("node:test");
var assert = require("node:assert");
var net = require("node:net");
var resolveUnmanagedDevStatus =
  require("../lib/project-workspace-dev-discovery").resolveUnmanagedDevStatus;
var isWorkspaceDevControl =
  require("../lib/project-workspace").isWorkspaceDevControl;
var probeIpv4Port = require("../lib/project-workspace-git").probePort;

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
  var checkedOwner = false;
  resolveUnmanagedDevStatus({
    det: { basePort: 3000 },
    boundDir: "/repo/.worktrees/feature-a",
    ownPorts: [],
    payload: payload,
    probePort: function (port, cb) {
      assert.strictEqual(port, 3000);
      cb(true);
    },
    portBelongsToDir: function (port, dir, cb) {
      checkedOwner = true;
      assert.strictEqual(port, 3000);
      assert.strictEqual(dir, "/repo/.worktrees/feature-a");
      cb(true);
    },
    findFreePort: function () {
      assert.fail("a live configured port must not be replaced");
    },
  }, function (status) {
    assert.strictEqual(checkedOwner, true);
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

test("does not claim a configured port owned by another worktree", function (_, done) {
  resolveUnmanagedDevStatus({
    det: { basePort: 3000 },
    boundDir: "/repo/.worktrees/feature-b",
    ownPorts: [],
    payload: payload,
    probePort: function (port, cb) {
      assert.strictEqual(port, 3000);
      cb(true);
    },
    portBelongsToDir: function (port, dir, cb) {
      assert.strictEqual(port, 3000);
      assert.strictEqual(dir, "/repo/.worktrees/feature-b");
      cb(false);
    },
    findFreePort: function (basePort, ownPorts, cb) {
      assert.strictEqual(basePort, 3000);
      assert.deepStrictEqual(ownPorts, []);
      cb(3001);
    },
  }, function (status) {
    assert.deepStrictEqual(status, payload({ port: 3001 }));
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
    probeIpv6Port: function (port, cb) { cb(false); },
    findFreePort: function (basePort, ownPorts, cb) { cb(3000); },
  }, function (status) {
    assert.deepStrictEqual(status, payload({ port: 3000 }));
    done();
  });
});

test("rejects stale or unrelated clicks as development server controls", function () {
  assert.strictEqual(isWorkspaceDevControl({
    type: "workspace_dev_stop",
  }), false);
  assert.strictEqual(isWorkspaceDevControl({
    type: "workspace_dev_stop",
    source: "workspace-dev-control",
  }), true);
});

test("detects a development server bound only to IPv6 localhost", function (t, done) {
  var server = net.createServer();
  server.on("error", function (error) {
    if (error && (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL")) {
      t.skip("IPv6 loopback is unavailable");
      done();
      return;
    }
    done(error);
  });
  server.listen({ host: "::1", port: 0, ipv6Only: true }, function () {
    var port = server.address().port;
    resolveUnmanagedDevStatus({
      det: { basePort: port },
      boundDir: "/repo/webapp",
      ownPorts: [],
      payload: payload,
      probePort: probeIpv4Port,
      portBelongsToDir: function (checkedPort, dir, cb) {
        assert.strictEqual(checkedPort, port);
        assert.strictEqual(dir, "/repo/webapp");
        cb(true);
      },
      findFreePort: function () {
        assert.fail("an IPv6 localhost listener must be detected");
      },
    }, function (status) {
      server.close(function () {
        assert.deepStrictEqual(status, payload({
          running: true,
          portLive: true,
          external: true,
          status: "external",
          port: port,
        }));
        done();
      });
    });
  });
});
