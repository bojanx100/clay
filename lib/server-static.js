var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");

var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function httpGetBinary(url) {
  return new Promise(function (resolve, reject) {
    var mod = url.startsWith("https") ? https : http;
    mod.get(url, { headers: { "User-Agent": "Clay/1.0" } }, function (resp) {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        return httpGetBinary(resp.headers.location).then(resolve, reject);
      }
      if (resp.statusCode !== 200) {
        return reject(new Error("HTTP " + resp.statusCode));
      }
      var chunks = [];
      resp.on("data", function (c) { chunks.push(c); });
      resp.on("end", function () { resolve(Buffer.concat(chunks)); });
      resp.on("error", reject);
    }).on("error", reject);
  });
}

function createStaticHandler(publicDir) {
  return function serveStatic(urlPath, res) {
    if (urlPath === "/") urlPath = "/index.html";

    var filePath = path.join(publicDir, urlPath);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return true;
    }

    try {
      var content = fs.readFileSync(filePath);
      var ext = path.extname(filePath);
      var mime = MIME_TYPES[ext] || "application/octet-stream";
      var isImage = ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".gif" || ext === ".svg" || ext === ".webp" || ext === ".ico";
      var cacheControl = isImage ? "public, max-age=86400, immutable" : "no-cache";
      res.writeHead(200, {
        "Content-Type": mime + (isImage ? "" : "; charset=utf-8"),
        "Cache-Control": cacheControl,
      });
      res.end(content);
      return true;
    } catch (e) {
      return false;
    }
  };
}

module.exports = {
  httpGetBinary: httpGetBinary,
  createStaticHandler: createStaticHandler,
};
