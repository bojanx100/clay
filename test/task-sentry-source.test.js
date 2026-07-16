var test = require("node:test");
var assert = require("node:assert");

var sentry = require("../lib/project-task-sentry-source");

test("extractGithubRefs reads GitHub links from Sentry integration issues", function () {
  var refs = sentry.extractGithubRefs({
    integrationIssues: [
      {
        displayName: "trialview/v2#2175",
        url: "https://github.com/trialview/v2/issues/2175",
      },
      {
        externalUrl: "https://github.com/trialview/v2/pull/1571",
      },
      {
        externalUrl: "https://github.com/other/repo/issues/99",
      },
    ],
  }, "trialview/v2", false);

  assert.strictEqual(refs["issue:2175"], true);
  assert.strictEqual(refs["any:2175"], true);
  assert.strictEqual(refs["pr:1571"], true);
  assert.strictEqual(refs["issue:99"], undefined);
});

test("sentryIssuesUrl uses org issues endpoint with integration expansion", function () {
  var url = sentry.sentryIssuesUrl({
    baseUrl: "https://sentry.example.com/",
    organization: "acme",
    project: ["webapp", "api"],
    query: "is:unresolved level:error",
    fetchLimit: 250,
  }, {});

  assert.ok(url.indexOf("https://sentry.example.com/api/0/organizations/acme/issues/?") === 0);
  assert.ok(url.indexOf("project=webapp") !== -1);
  assert.ok(url.indexOf("project=api") !== -1);
  assert.ok(url.indexOf("query=is%3Aunresolved%20level%3Aerror") !== -1);
  assert.ok(url.indexOf("limit=100") !== -1);
  assert.ok(url.indexOf("expand=integrationIssues") !== -1);
});

test("sentryIssuesUrl falls back to SENTRY_URL", function () {
  var oldUrl = process.env.SENTRY_URL;
  var oldOrg = process.env.SENTRY_ORG;
  try {
    process.env.SENTRY_URL = "https://de.sentry.io";
    process.env.SENTRY_ORG = "trialview";
    var url = sentry.sentryIssuesUrl({ project: "v2" }, {});
    assert.ok(url.indexOf("https://de.sentry.io/api/0/organizations/trialview/issues/?") === 0);
  } finally {
    if (oldUrl === undefined) delete process.env.SENTRY_URL;
    else process.env.SENTRY_URL = oldUrl;
    if (oldOrg === undefined) delete process.env.SENTRY_ORG;
    else process.env.SENTRY_ORG = oldOrg;
  }
});
