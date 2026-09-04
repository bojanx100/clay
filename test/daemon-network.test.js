var test = require("node:test");
var assert = require("node:assert");
var daemonNetwork = require("../lib/daemon-network");

test("tailscaleServeUrlForPort returns the real HTTPS mapping for a local dev port", function () {
  var status = {
    TCP: {
      "443": { HTTPS: true },
      "6075": { HTTPS: true },
      "8443": { HTTPS: true },
    },
    Web: {
      "bojans-macbook-pro-2.taila85e50.ts.net:443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
      },
      "bojans-macbook-pro-2.taila85e50.ts.net:6075": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:6075" } },
      },
      "bojans-macbook-pro-2.taila85e50.ts.net:8443": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:3001" } },
      },
    },
  };
  assert.strictEqual(
    daemonNetwork.tailscaleServeUrlForPort(6075, status),
    "https://bojans-macbook-pro-2.taila85e50.ts.net:6075/"
  );
  assert.strictEqual(
    daemonNetwork.tailscaleServeUrlForPort(3000, status),
    "https://bojans-macbook-pro-2.taila85e50.ts.net/"
  );
  assert.strictEqual(
    daemonNetwork.tailscaleServeUrlForPort(3001, status),
    "https://bojans-macbook-pro-2.taila85e50.ts.net:8443/"
  );
  assert.strictEqual(daemonNetwork.tailscaleServeUrlForPort(4242, status), null);
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
