var test = require("node:test");
var assert = require("node:assert");
var daemonNetwork = require("../lib/daemon-network");

test("resolveTailscaleIp returns only an active Tailscale CGNAT address", function () {
  var interfaces = {
    en0: [
      { family: "IPv4", internal: false, address: "192.168.1.10" },
      { family: "IPv4", internal: false, address: "100.63.2.3" },
    ],
    utun4: [
      { family: "IPv4", internal: false, address: "100.124.11.117" },
    ],
  };
  assert.strictEqual(daemonNetwork.resolveTailscaleIp(interfaces), "100.124.11.117");
});

test("resolveTailscaleIp stays empty without a connected Tailscale interface", function () {
  var interfaces = {
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.10" }],
    lo0: [{ family: "IPv4", internal: true, address: "100.100.100.100" }],
  };
  assert.strictEqual(daemonNetwork.resolveTailscaleIp(interfaces), null);
});

test("tailscaleUrlForPort exposes the dev port only while Tailscale is connected", function () {
  var connected = {
    utun4: [{ family: "IPv4", internal: false, address: "100.124.11.117" }],
  };
  var disconnected = {
    en0: [{ family: "IPv4", internal: false, address: "192.168.1.10" }],
  };
  assert.strictEqual(
    daemonNetwork.tailscaleUrlForPort(3000, connected),
    "http://100.124.11.117:3000"
  );
  assert.strictEqual(daemonNetwork.tailscaleUrlForPort(3000, disconnected), null);
  assert.strictEqual(daemonNetwork.tailscaleUrlForPort(null, connected), null);
});

test("shouldRefreshBuiltinCert only enables builtin HTTPS refreshes", function () {
  assert.strictEqual(daemonNetwork.shouldRefreshBuiltinCert({ tls: true, builtinCert: true }), true);
  assert.strictEqual(daemonNetwork.shouldRefreshBuiltinCert({ tls: false, builtinCert: true }), false);
  assert.strictEqual(daemonNetwork.shouldRefreshBuiltinCert({ tls: true, builtinCert: false }), false);
  assert.strictEqual(daemonNetwork.shouldRefreshBuiltinCert(null), false);
});

test("refreshBuiltinCertCache skips non-builtin configurations", async function () {
  var called = false;
  var result = await daemonNetwork.refreshBuiltinCertCache({ tls: true, builtinCert: false }, 123, {
    refreshCache: function () {
      called = true;
      return Promise.resolve(true);
    },
  });

  assert.strictEqual(result, false);
  assert.strictEqual(called, false);
});

test("refreshBuiltinCertCache refreshes builtin HTTPS cache", async function () {
  var timeout = null;
  var result = await daemonNetwork.refreshBuiltinCertCache({ tls: true, builtinCert: true }, 123, {
    refreshCache: function (timeoutMs) {
      timeout = timeoutMs;
      return Promise.resolve(true);
    },
  });

  assert.strictEqual(result, true);
  assert.strictEqual(timeout, 123);
});

test("refreshBuiltinCertCache ignores refresh failures", async function () {
  var result = await daemonNetwork.refreshBuiltinCertCache({ tls: true, builtinCert: true }, 123, {
    refreshCache: function () {
      return Promise.reject(new Error("offline"));
    },
  });

  assert.strictEqual(result, false);
});
