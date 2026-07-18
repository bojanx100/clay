// project-task-dashboard-page.js - Serve project dashboards through Clay HTTPS.

var fs = require("fs");
var path = require("path");

var MIME_TYPES = {
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

var DASHBOARD_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src * data: blob:; connect-src 'self' ws: wss: https://api.github.com https://cdn.jsdelivr.net https://esm.sh; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;";

function readDashboardPagePath(cwd) {
  var fallback = path.join(cwd, "localAIConfig", "outstanding-issues.html");
  var configPath = path.join(cwd, ".clay", "tasks", "config.json");
  var config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    return fallback;
  }

  var dashboards = Array.isArray(config.dashboards) ? config.dashboards : [];
  for (var i = 0; i < dashboards.length; i++) {
    if (!dashboards[i] || typeof dashboards[i].page !== "string") continue;
    var configured = path.resolve(cwd, dashboards[i].page);
    if (configured === cwd || configured.indexOf(cwd + path.sep) === 0) return configured;
    return null;
  }
  return fallback;
}

function resolveDashboardFile(pagePath, urlPath) {
  if (!pagePath) return null;
  var baseDir = path.dirname(pagePath);
  var cleanPath = String(urlPath || "").split("?")[0];
  var relativePath;
  try {
    relativePath = cleanPath === "/dashboard/"
      ? path.basename(pagePath)
      : decodeURIComponent(cleanPath.substring("/dashboard/".length));
  } catch (e) {
    return null;
  }
  var resolved = path.resolve(baseDir, relativePath);
  if (resolved !== baseDir && resolved.indexOf(baseDir + path.sep) !== 0) return null;
  return resolved;
}

function rewriteDashboardHtml(html, slug) {
  var launchPath = "/p/" + encodeURIComponent(slug) + "/api/task-launch";
  var legacyLaunchUrl = /var\s+CLAY_LAUNCH_URL\s*=\s*(["'])https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/p\/[^/"']+\/api\/task-launch\1\s*;/;
  return html.replace(legacyLaunchUrl, "var CLAY_LAUNCH_URL=" + JSON.stringify(launchPath) + ";");
}

function serveDashboardPage(cwd, slug, req, res, urlPath) {
  if (req.method !== "GET" || (urlPath !== "/dashboard" && urlPath.indexOf("/dashboard/") !== 0)) return false;
  if (urlPath === "/dashboard") {
    res.writeHead(302, { "Location": "/p/" + encodeURIComponent(slug) + "/dashboard/" });
    res.end();
    return true;
  }

  var pagePath = readDashboardPagePath(cwd);
  var filePath = resolveDashboardFile(pagePath, urlPath);
  if (!filePath) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }

  fs.readFile(filePath, function (error, content) {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Dashboard not found");
      return;
    }
    var extension = path.extname(filePath).toLowerCase();
    var mime = MIME_TYPES[extension] || "application/octet-stream";
    if (extension === ".html") content = Buffer.from(rewriteDashboardHtml(content.toString("utf8"), slug), "utf8");
    res.writeHead(200, {
      "Cache-Control": "no-cache, no-store",
      "Content-Security-Policy": DASHBOARD_CSP,
      "Content-Type": mime + (/^(text\/|application\/(javascript|json))/.test(mime) ? "; charset=utf-8" : ""),
    });
    res.end(content);
  });
  return true;
}

module.exports = {
  readDashboardPagePath: readDashboardPagePath,
  resolveDashboardFile: resolveDashboardFile,
  rewriteDashboardHtml: rewriteDashboardHtml,
  serveDashboardPage: serveDashboardPage,
};
