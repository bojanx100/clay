var test = require("node:test");
var assert = require("node:assert/strict");

test("client vendor presentation maps are hydrated from server registry data", async function () {
  var ui = await import("../lib/public/modules/vendor-ui.js");
  ui.applyVendorRegistry({
    codex: {
      displayName: "Codex Test",
      avatar: "/test-codex.png",
      homepage: "https://example.test/codex",
    },
    claude: {
      displayName: "Claude Test",
      avatar: "/test-claude.png",
      homepage: "https://example.test/claude",
    },
  });

  assert.deepStrictEqual(ui.VENDOR_ORDER, ["codex", "claude"]);
  assert.deepStrictEqual(ui.VENDOR_NAMES, { codex: "Codex Test", claude: "Claude Test" });
  assert.deepStrictEqual(ui.VENDOR_AVATARS, { codex: "/test-codex.png", claude: "/test-claude.png" });
  assert.deepStrictEqual(ui.VENDOR_HOMEPAGES, {
    codex: "https://example.test/codex",
    claude: "https://example.test/claude",
  });
});
