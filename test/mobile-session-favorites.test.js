var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

test("mobile favorites have a persistent visual marker", function () {
  var mobileSidebarPath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js");
  var cssPath = path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css");
  var mobileSidebarSource = fs.readFileSync(mobileSidebarPath, "utf8");
  var css = fs.readFileSync(cssPath, "utf8");

  assert.match(mobileSidebarSource, /s\.bookmarked \? " bookmarked" : ""/);
  assert.match(mobileSidebarSource, /favoriteIcon\.className = "mobile-session-favorite"/);
  assert.match(mobileSidebarSource, /favoriteIcon\.innerHTML = iconHtml\("star"\)/);
  assert.match(css, /\.mobile-session-favorite\s*\{[^}]*color:\s*var\(--accent\)/s);
  assert.match(css, /\.mobile-session-favorite svg\s*\{[^}]*fill:\s*currentColor/s);
});

test("single-user mobile chat does not render Mate chips", function () {
  var mobileSidebarPath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js");
  var mobileSidebarSource = fs.readFileSync(mobileSidebarPath, "utf8");

  // Single user still yields no chips, and the gate is now stricter: mates also
  // require the authoritative opt-in flag, so a multi-user server with mates
  // disabled renders none either. See test/mobile-mates-disabled.test.js.
  assert.match(mobileSidebarSource, /function mobileMatesEnabled\(\)/);
  assert.match(mobileSidebarSource, /!!store\.get\('isMultiUserMode'\)/);
  assert.match(mobileSidebarSource, /if \(!mobileMatesEnabled\(\)\) return \[\];/);
});
