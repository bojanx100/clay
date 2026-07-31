var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

test("mobile session sheet nests workers beneath coordinators by default", async function () {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js");
  var coordinatorModule = await import(pathToFileURL(modulePath).href);
  var coordinator = { id: 10, coordinationMode: true, lastActivity: 30 };
  var olderWorker = { id: 11, orchestrationParent: { sessionId: 10 }, lastActivity: 10 };
  var newerWorker = { id: 12, orchestrationParent: { sessionId: 10 }, lastActivity: 20 };
  var ordinary = { id: 13, lastActivity: 15 };
  var items = coordinatorModule.buildMobileCoordinatorItems([
    olderWorker,
    ordinary,
    coordinator,
    newerWorker
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].type, "session");
  assert.equal(items[0].data.id, 13);
  assert.equal(items[1].type, "coordinator");
  assert.equal(items[1].data.id, 10);
  assert.deepEqual(items[1].children.map(function (session) { return session.id; }), [12, 11]);
});

test("coordinator groups always show workers without collapse controls", function () {
  var source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile.js"),
    "utf8"
  );
  var groupingSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-mobile-coordinators.js"),
    "utf8"
  );
  var desktopSource = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions.js"),
    "utf8"
  );
  var css = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "css", "mobile-nav.css"),
    "utf8"
  );
  var desktopCss = fs.readFileSync(
    path.join(__dirname, "..", "lib", "public", "css", "sidebar.css"),
    "utf8"
  );

  assert.match(source, /mobile-session-role-badge coordinator/);
  assert.match(source, /mobile-session-role-badge worker/);
  assert.match(groupingSource, /var children = document\.createElement\("div"\)/);
  assert.doesNotMatch(groupingSource, /expandedCoordinatorGroups|mobile-coordinator-toggle|aria-expanded/);
  assert.doesNotMatch(desktopSource, /expandedCoordinatorGroups|session-coordinator-toggle/);
  assert.match(css, /\.mobile-coordinator-workers\s*\{/);
  assert.match(css, /\.mobile-session-item\.mobile-coordinator-worker\s*\{/);
  assert.match(css, /\.mobile-session-item\.mobile-coordinator-parent\s*\{/);
  assert.doesNotMatch(css, /\.mobile-coordinator-toggle/);
  assert.match(desktopCss, /\.session-item\.session-coordinator-parent\s*\{/);
  assert.doesNotMatch(desktopCss, /\.session-coordinator-toggle/);
});
