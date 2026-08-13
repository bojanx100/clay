var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

function source(file) {
  return fs.readFileSync(path.join(__dirname, "..", "lib", "public", file), "utf8");
}

test("Lead to Clay synchronous switches clear source rows before the target session list arrives", function () {
  var projects = source("modules/app-projects.js");
  var sessions = source("modules/sidebar-sessions.js");
  var messages = source("modules/app-messages-sessions.js");

  assert.match(projects, /store\.set\(\{ currentSlug: slug \}\);\s+window\.dispatchEvent\(new CustomEvent\("clay:project-switching"/);
  assert.match(sessions, /function prepareSessionListForProject\(slug\) \{\s+cachedSessions = \[\];\s+cachedSessionsSlug = ""/);
  assert.match(sessions, /if \(isSessionListLoading\(\)\) \{[\s\S]*Loading conversations/);
  assert.match(messages, /if \(msg\.projectSlug && msg\.projectSlug !== store\.get\('currentSlug'\)\) return;/);
});

test("all plain Lead entry points route to canonical Coop home and preserve exact refs", function () {
  var projects = source("modules/app-projects.js");
  var app = source("app.js");
  var connection = source("modules/app-connection.js");
  var connectionPolicy = source("modules/connection-policy.js");
  var messages = source("modules/app-messages-sessions.js");
  var desktop = source("modules/sidebar-sessions.js");
  var mobile = source("modules/sidebar-mobile.js");

  assert.match(projects, /export function restoreCanonicalLeadHome\(\)/);
  assert.match(projects, /if \(slug === "lead"\) \{\s+restoreCanonicalLeadHome\(\);/);
  assert.match(app, /if \(newSlug === "lead" && !urlRef\) \{\s+syncCoopLensFromUrl\(_connSendUserAction\);\s+renderSessionList\(null\);\s+_projRestoreCanonicalLeadHome\(\);/);
  assert.match(connection, /initialSessionReference\(\{/);
  assert.match(connectionPolicy, /options\.currentSlug === "lead" && !options\.urlSessionRef/);
  assert.match(projects, /connect\(\{ preferProjectDefault: !\(options && options\.sessionRef\) \}\)/);
  assert.match(messages, /store\.set\(\{ coopHomeSessionId: coopHome \? coopHome\.id : null \}\)/);
  assert.match(messages, /if \(currentSlug === "lead" && msg\.coopHome\) forgetTabSession\(currentSlug\);/);
  assert.match(desktop, /renderCoopTopicSections/);
  assert.match(mobile, /renderCoopTopicSections/);
  assert.match(projects, /options\.sessionRef\.sessionStorageId/);
});

test("selecting the already-current project revalidates its default session", function () {
  var projects = source("modules/app-projects.js");
  var sameProject = projects.slice(
    projects.indexOf("if (slug === store.get('currentSlug'))"),
    projects.indexOf("resetFileBrowser();")
  );

  assert.match(sameProject, /resetClientState\(\);\s+connect\(\{ preferProjectDefault: true \}\);\s+return;/);
  assert.doesNotMatch(projects, /isHomeHubVisible\(\)[\s\S]{0,180}preferProjectDefault\)\) return/);
});

test("Back and Forward use the same target-keyed session cache reset", function () {
  var app = source("app.js");
  assert.match(app, /store\.set\(\{ currentSlug: newSlug \}\);\s+window\.dispatchEvent\(new CustomEvent\("clay:project-switching"/);
});

test("mobile uses the same neutral target loading state and never renders a stale list", function () {
  var mobile = source("modules/sidebar-mobile.js");
  assert.match(mobile, /if \(isSessionListLoading\(\)\) \{[\s\S]*mobile-session-list-target-loading/);
});
