var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");

var helperSource = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "standalone-launch.js"), "utf8");
var indexSource = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");

function runHelper(locationState, mode) {
  var addedClasses = [];
  var replaceCalls = [];
  var context = {
    document: {
      documentElement: {
        classList: {
          add: function (name) { addedClasses.push(name); },
        },
      },
    },
    window: {
      navigator: { standalone: mode === "ios" },
      matchMedia: function () { return { matches: mode === "display" }; },
      location: locationState,
      history: {
        replaceState: function (state, title, url) { replaceCalls.push(url); },
      },
    },
  };
  vm.runInNewContext(helperSource, context);
  return { addedClasses: addedClasses, replaceCalls: replaceCalls };
}

test("canonicalizes every restored standalone launch before app initialization", function () {
  var paths = [
    { pathname: "/", search: "", hash: "" },
    { pathname: "/p/clay/", search: "", hash: "" },
    { pathname: "/p/lead/", search: "?sessionRef=old-worker", hash: "" },
    { pathname: "/p/lead/", search: "", hash: "#scheduler" },
  ];
  for (var i = 0; i < paths.length; i++) {
    var result = runHelper(paths[i], "display");
    assert.deepEqual(result.addedClasses, ["pwa-standalone"]);
    assert.deepEqual(result.replaceCalls, ["/p/lead/"]);
  }
});

test("leaves ordinary browser routes and the canonical standalone route unchanged", function () {
  var browser = runHelper({ pathname: "/p/clay/", search: "?sessionRef=browser-session", hash: "#scheduler" }, "browser");
  assert.deepEqual(browser.addedClasses, []);
  assert.deepEqual(browser.replaceCalls, []);

  var canonical = runHelper({ pathname: "/p/lead/", search: "", hash: "" }, "ios");
  assert.deepEqual(canonical.addedClasses, ["pwa-standalone"]);
  assert.deepEqual(canonical.replaceCalls, []);
});

test("loads the blocking standalone guard before app.js and uses the canonical manifest entry", function () {
  assert.ok(indexSource.indexOf('<script src="/standalone-launch.js"></script>') < indexSource.indexOf('<script type="module" src="app.js"></script>'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "lib", "public", "manifest.json"), "utf8")).start_url, "/p/lead/");
});
