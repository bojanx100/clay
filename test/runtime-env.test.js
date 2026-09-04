var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var runtimeEnv = require("../lib/runtime-env");

test("runtime environment parses data assignments without executing shell syntax", function () {
  assert.deepEqual(runtimeEnv.parseEnvrc("# comment\nexport TOKEN=shared\nNAME=\"two words\"\nSINGLE='literal value'"), {
    TOKEN: "shared",
    NAME: "two words",
    SINGLE: "literal value",
  });
  assert.match(runtimeEnv.validateEnvString("source .env"), /Unsupported syntax at line 1/);
  assert.match(runtimeEnv.validateEnvString("VALUE=before; command"), /Unsupported executable syntax/);
  assert.match(runtimeEnv.validateEnvString("BAD-KEY=value"), /Invalid variable name/);
  assert.match(runtimeEnv.validateEnvString("VALUE=\0"), /NUL bytes/);
  assert.deepEqual(runtimeEnv.parseEnvrc('TOKEN="a;$(literal)|secret"'), { TOKEN: "a;$(literal)|secret" });
});

test("environment validation errors do not include secret values", function () {
  var error = runtimeEnv.validateEnvString("INVALID-KEY=top-secret-value");
  assert.ok(error);
  assert.equal(error.indexOf("top-secret-value"), -1);
});

test("project values win without replacing Clay or operating-system controls", function () {
  var resolved = runtimeEnv.resolveRuntimeEnv({
    baseEnv: { PATH: "/safe/bin", HOME: "/safe/home", CLAY_AUTH_TOKEN: "protected", FROM_BASE: "base", VALUE: "base" },
    sharedEnvrc: "VALUE=shared\nSHARED_ONLY=shared\nPATH=/unsafe\nCLAY_AUTH_TOKEN=leak",
    projectEnvrc: "VALUE=project\nPROJECT_ONLY=project\nHOME=/unsafe-home",
  });
  assert.equal(resolved.VALUE, "project");
  assert.equal(resolved.SHARED_ONLY, "shared");
  assert.equal(resolved.PROJECT_ONLY, "project");
  assert.equal(resolved.FROM_BASE, "base");
  assert.equal(resolved.PATH, "/safe/bin");
  assert.equal(resolved.HOME, "/safe/home");
  assert.equal(resolved.CLAY_AUTH_TOKEN, "protected");
});

test("separate resolution calls do not leak project or user values", function () {
  var first = runtimeEnv.resolveRuntimeEnv({ baseEnv: { HOME: "/users/alice" }, sharedEnvrc: "SHARED=1", projectEnvrc: "PROJECT=alpha\nPRIVATE=alice" });
  var second = runtimeEnv.resolveRuntimeEnv({ baseEnv: { HOME: "/users/bob" }, sharedEnvrc: "SHARED=1", projectEnvrc: "PROJECT=beta" });
  assert.equal(first.HOME, "/users/alice");
  assert.equal(second.HOME, "/users/bob");
  assert.equal(first.PROJECT, "alpha");
  assert.equal(second.PROJECT, "beta");
  assert.equal(second.PRIVATE, undefined);
});

test("environment settings serialize arbitrary values and explain process timing", function () {
  var projectSettings = fs.readFileSync(path.join(__dirname, "../lib/public/modules/project-settings.js"), "utf8");
  var serverSettings = fs.readFileSync(path.join(__dirname, "../lib/public/modules/server-settings.js"), "utf8");
  var html = fs.readFileSync(path.join(__dirname, "../lib/public/index.html"), "utf8");
  assert.match(projectSettings, /JSON\.stringify\(value == null \? "" : String\(value\)\)/);
  assert.match(serverSettings, /serializeEnvValue/);
  assert.match(html, /newly created coding-agent processes/);
  assert.match(html, /active processes, terminals, the daemon, and the browser keep their current environment/i);
  assert.equal(html.indexOf(".envrc</code> file exists"), -1);
});
