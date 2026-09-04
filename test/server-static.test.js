var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var zlib = require("node:zlib");
var createStaticHandler = require("../lib/server-static").createStaticHandler;

function responseCapture() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead: function (status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end: function (body) {
      this.body = body;
    },
  };
}

test("static handler prefers Brotli and preserves the original response", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-static-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var source = "<html>" + "Clay stays sharp. ".repeat(300) + "</html>";
  fs.writeFileSync(path.join(dir, "index.html"), source);
  var serve = createStaticHandler(dir);
  var res = responseCapture();

  assert.equal(serve("/index.html", res, {
    headers: { "accept-encoding": "gzip, br" },
  }), true);
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Encoding"], "br");
  assert.equal(res.headers.Vary, "Accept-Encoding");
  assert.equal(zlib.brotliDecompressSync(res.body).toString(), source);
  assert.ok(res.body.length < Buffer.byteLength(source));
});

test("static handler respects disabled encodings and still varies caches", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-static-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  var source = "var clay = " + JSON.stringify("fast".repeat(400)) + ";";
  fs.writeFileSync(path.join(dir, "app.js"), source);
  var serve = createStaticHandler(dir);
  var res = responseCapture();

  assert.equal(serve("/app.js", res, {
    headers: { "accept-encoding": "br;q=0, gzip;q=0" },
  }), true);
  assert.equal(res.headers["Content-Encoding"], undefined);
  assert.equal(res.headers.Vary, "Accept-Encoding");
  assert.equal(res.body.toString(), source);
});

test("static handler leaves small assets uncompressed", function (t) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-static-"));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "tiny.js"), "var clay = true;");
  var serve = createStaticHandler(dir);
  var res = responseCapture();

  assert.equal(serve("/tiny.js", res, {
    headers: { "accept-encoding": "br, gzip" },
  }), true);
  assert.equal(res.headers["Content-Encoding"], undefined);
  assert.equal(res.headers.Vary, undefined);
  assert.equal(res.body.toString(), "var clay = true;");
});
