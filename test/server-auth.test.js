// Multi-user auth tokens are the only record of who is logged in. Resetting
// them to {} after a failed read and then persisting that empty map is a
// silent, unrecoverable mass logout, so the store must fail closed: ENOENT is
// the only fresh install, everything else keeps the on-disk file intact.
var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var attachAuth = require("../lib/server-auth").attachAuth;

function usersStub() {
  var counter = 0;
  var records = { "user-1": { id: "user-1", username: "owner", role: "admin" } };
  return {
    isMultiUser: function () { return true; },
    hasAdmin: function () { return true; },
    findUserById: function (id) { return records[id] || null; },
    getSoloNoPinUser: function () { return null; },
    generateUserAuthToken: function (userId) { return userId + "-token-" + (++counter); },
  };
}

function pagesStub() {
  return {
    pinPageHtml: function () { return "pin"; },
    adminSetupPageHtml: function () { return "setup"; },
    multiUserLoginPageHtml: function () { return "login"; },
    smtpLoginPageHtml: function () { return "smtp"; },
  };
}

function controllableFs(state) {
  return {
    readFileSync: function (target, encoding) {
      if (state.readError) throw state.readError;
      return fs.readFileSync(target, encoding);
    },
    mkdirSync: function (target, options) { return fs.mkdirSync(target, options); },
    writeFileSync: function (target, data, options) {
      if (state.failWrites) {
        var error = new Error("simulated write failure");
        error.code = "ENOSPC";
        throw error;
      }
      return fs.writeFileSync(target, data, options);
    },
    renameSync: function (from, to) { return fs.renameSync(from, to); },
  };
}

function auth(options) {
  var settings = options || {};
  var events = [];
  var instance = attachAuth({
    users: settings.users || usersStub(),
    smtp: { isEmailLoginEnabled: function () { return false; } },
    pages: pagesStub(),
    tlsOptions: null,
    osUsers: false,
    tokensFile: settings.tokensFile,
    fs: settings.fs,
    recordRecoveryEvent: function (event) { events.push(event); },
  });
  return { auth: instance, events: events };
}

function ops(events) {
  return events.map(function (event) { return event.store + ":" + event.op; });
}

function cookieRequest(token) {
  return { headers: { cookie: "relay_auth_user=" + token + "; relay_auth_user_dev=" + token } };
}

test("a corrupt auth token file is never replaced by an empty token map", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-server-auth-corrupt-"));
  var file = path.join(dir, "auth-tokens.json");
  var corrupt = '{"existing-token":"user-1","truncated-toke';
  fs.writeFileSync(file, corrupt);
  var attached = auth({ tokensFile: file });

  assert.deepEqual(attached.auth.tokenPersistenceState(), { code: "invalid_json" });
  assert.equal(attached.events.length, 1);
  assert.equal(attached.events[0].kind, "coop_persistence");
  assert.equal(attached.events[0].store, "auth_tokens");
  assert.equal(attached.events[0].op, "parse");

  // Auth may proceed in memory (the owner re-logs in) but the intact file on
  // disk must survive untouched for the next boot.
  var session = attached.auth.createMultiUserSession("user-1");
  assert.equal(fs.readFileSync(file, "utf8"), corrupt);
  assert.deepEqual(ops(attached.events), ["auth_tokens:parse", "auth_tokens:write_refused"]);
  var user = attached.auth.getMultiUserFromReq(cookieRequest(session.token));
  assert.equal(user && user.id, "user-1");
});

test("an unreadable auth token file keeps the on-disk tokens instead of resetting", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-server-auth-unreadable-"));
  var file = path.join(dir, "auth-tokens.json");
  var intact = JSON.stringify({ "existing-token": "user-1" });
  fs.writeFileSync(file, intact);
  var readError = new Error("too many open files");
  readError.code = "EMFILE";
  var attached = auth({ tokensFile: file, fs: controllableFs({ readError: readError }) });

  assert.deepEqual(attached.auth.tokenPersistenceState(), { code: "EMFILE" });
  attached.auth.createMultiUserSession("user-1");
  attached.auth.revokeUserTokens("user-1");
  assert.equal(fs.readFileSync(file, "utf8"), intact);
  assert.deepEqual(ops(attached.events),
    ["auth_tokens:read", "auth_tokens:write_refused", "auth_tokens:write_refused"]);
});

test("a token file that is not a token map fails closed", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-server-auth-shape-"));
  var file = path.join(dir, "auth-tokens.json");
  fs.writeFileSync(file, "[]");
  var attached = auth({ tokensFile: file });

  assert.deepEqual(attached.auth.tokenPersistenceState(), { code: "invalid_shape" });
  attached.auth.createMultiUserSession("user-1");
  assert.equal(fs.readFileSync(file, "utf8"), "[]");
  assert.deepEqual(ops(attached.events), ["auth_tokens:validate", "auth_tokens:write_refused"]);
});

test("a missing auth token file still initializes a fresh store silently", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-server-auth-fresh-"));
  var file = path.join(dir, "auth-tokens.json");
  var attached = auth({ tokensFile: file });

  // Asserted through behaviour only, so this test also passes before the
  // fail-closed fix: fresh-install handling must not change at all.
  var session = attached.auth.createMultiUserSession("user-1");
  assert.deepEqual(attached.events, []);
  var written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written[session.token], "user-1");
  var user = attached.auth.getMultiUserFromReq(cookieRequest(session.token));
  assert.equal(user && user.id, "user-1");
});

test("a failed token write records a canary instead of silently evaporating", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-server-auth-write-"));
  var file = path.join(dir, "auth-tokens.json");
  var attached = auth({ tokensFile: file, fs: controllableFs({ failWrites: true }) });

  assert.equal(attached.auth.tokenPersistenceState(), null);
  attached.auth.createMultiUserSession("user-1");
  assert.deepEqual(ops(attached.events), ["auth_tokens:write"]);
  assert.equal(attached.events[0].code, "ENOSPC");
  assert.equal(fs.existsSync(file), false);
});
