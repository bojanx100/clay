var test = require("node:test");
var assert = require("node:assert/strict");

var codexAdapter = require("../lib/yoke/adapters/codex");

test("Codex preserves Clay bridge connectivity across app-server restarts", function() {
  var initialDefaults = { cwd: "/workspace", slug: "webapp" };
  var connectedInit = {
    clayPort: 7292,
    clayTls: true,
    clayAuthToken: "session-token",
    slug: "webapp",
    linuxUser: "owner-a",
  };

  var retained = codexAdapter._test.retainClayConnectionOptions(
    initialDefaults,
    connectedInit,
  );
  var restarted = Object.assign({}, retained, { model: "gpt-5.6-sol" });

  assert.equal(restarted.clayPort, 7292);
  assert.equal(restarted.clayTls, true);
  assert.equal(restarted.clayAuthToken, "session-token");
  assert.equal(restarted.slug, "webapp");
  assert.equal(restarted.linuxUser, undefined);
});

test("Codex accepts explicit Clay bridge connection changes", function() {
  var retained = codexAdapter._test.retainClayConnectionOptions(
    {
      clayPort: 7292,
      clayTls: true,
      clayAuthToken: "session-token",
      slug: "webapp",
    },
    {
      clayPort: 2633,
      clayTls: false,
      clayAuthToken: "",
      slug: "local",
    },
  );

  assert.deepEqual(retained, {
    clayPort: 2633,
    clayTls: false,
    clayAuthToken: "",
    slug: "local",
  });
});
