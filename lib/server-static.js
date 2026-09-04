var http = require("http");
var https = require("https");
var fs = require("fs");
var path = require("path");
var zlib = require("zlib");

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

function acceptsEncoding(header, target) {
  var parts = String(header || "").toLowerCase().split(",");
  for (var i = 0; i < parts.length; i++) {
    var fields = parts[i].trim().split(";");
    if (fields[0].trim() !== target) continue;
    for (var j = 1; j < fields.length; j++) {
      if (/^q\s*=\s*0(?:\.0*)?$/.test(fields[j].trim())) return false;
    }
    return true;
  }
  return false;
}

function createStaticHandler(publicDir) {
  var compressedCache = new Map();

  return function serveStatic(urlPath, res, req) {
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
      var isCompressible = ext === ".html" || ext === ".css" || ext === ".js" || ext === ".json" || ext === ".svg";
      var cacheControl = isImage ? "public, max-age=86400, immutable" : "no-cache";
      var headers = {
        "Content-Type": mime + (isImage ? "" : "; charset=utf-8"),
        "Cache-Control": cacheControl,
      };
      var acceptEncoding = req && req.headers ? String(req.headers["accept-encoding"] || "") : "";
      var encoding = null;
      if (isCompressible && content.length >= 1024) {
        headers["Vary"] = "Accept-Encoding";
        if (acceptsEncoding(acceptEncoding, "br")) encoding = "br";
        else if (acceptsEncoding(acceptEncoding, "gzip")) encoding = "gzip";
      }
      if (encoding) {
        var stat = fs.statSync(filePath);
        var cacheKey = filePath + ":" + encoding;
        var cached = compressedCache.get(cacheKey);
        if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
          cached = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            content: encoding === "br"
            ? zlib.brotliCompressSync(content, {
                params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
              })
            : zlib.gzipSync(content, { level: 6 }),
          };
          compressedCache.set(cacheKey, cached);
        }
        headers["Content-Encoding"] = encoding;
        content = cached.content;
      }
      res.writeHead(200, headers);
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
