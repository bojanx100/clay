var test = require("node:test");
var assert = require("node:assert/strict");
var dashboardPage = require("../lib/project-task-dashboard-page");

test("rewrites legacy loopback launch URLs to the current Clay project", function () {
  var html = '<script>var CLAY_LAUNCH_URL="https://127.0.0.1:7292/p/webapp/api/task-launch";</script>';
  var rewritten = dashboardPage.rewriteDashboardHtml(html, "webapp");

  assert.equal(rewritten, '<script>var CLAY_LAUNCH_URL="/p/webapp/api/task-launch";</script>');
});

test("leaves unrelated dashboard HTML unchanged", function () {
  var html = '<script>var OTHER_URL="https://example.com";</script>';
  assert.equal(dashboardPage.rewriteDashboardHtml(html, "webapp"), html);
});

test("resolves dashboard files inside the configured page directory", function () {
  var pagePath = "/tmp/project/localAIConfig/outstanding-issues.html";

  assert.equal(
    dashboardPage.resolveDashboardFile(pagePath, "/dashboard/"),
    pagePath
  );
  assert.equal(
    dashboardPage.resolveDashboardFile(pagePath, "/dashboard/styles.css"),
    "/tmp/project/localAIConfig/styles.css"
  );
  assert.equal(
    dashboardPage.resolveDashboardFile(pagePath, "/dashboard/?refresh=1"),
    pagePath
  );
  assert.equal(dashboardPage.resolveDashboardFile(pagePath, "/dashboard/../secret"), null);
});
