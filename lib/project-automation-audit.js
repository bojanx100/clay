// project-automation-audit.js - Append-only audit of every project-automation
// authority decision.
//
// The cutover's central claim is that legacy automation can no longer act on
// its own initiative. That claim is only checkable if every decision leaves a
// record — including the allowed ones, and especially the Lead-mode-off
// pass-throughs, because "it acted, and nothing says why" is the failure mode
// this file exists to prevent.
//
// One JSONL file per project slug, mirroring the coop-self-cleanup audit
// layout. Writes are best-effort and never throw: an audit failure must not
// take down a daemon tick, but it is surfaced through lastError() so a broken
// audit is observable rather than silent.

var fs = require("fs");
var path = require("path");
var config = require("./config");

var AUDIT_DIR = "automation-audit";
var MAX_LINE_BYTES = 8192;

function auditDir() {
  return path.join(config.CONFIG_DIR, AUDIT_DIR);
}

// Slugs come from project registration, but this builds a filesystem path, so
// anything that is not a plain name is rejected rather than sanitized —
// silently rewriting a traversal attempt into a nearby filename is worse than
// refusing it.
function safeSlug(slug) {
  var value = String(slug || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "";
}

function auditFileForProject(slug) {
  var name = safeSlug(slug);
  return name ? path.join(auditDir(), name + ".jsonl") : "";
}

function createAutomationAudit(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var slug = safeSlug(opts.slug);
  var file = opts.file || (slug ? auditFileForProject(slug) : "");
  var now = opts.now || Date.now;
  var lastError = null;

  // Records arrive from the pure authority module, which already stamps the
  // decision. Only transport fields are added here.
  function append(record) {
    if (!file) {
      lastError = "invalid_slug";
      return { ok: false, reason: lastError };
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      lastError = "invalid_record";
      return { ok: false, reason: lastError };
    }
    var entry = Object.assign({}, record);
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) entry.at = now();
    entry.recordedAt = now();
    if (slug) entry.projectSlug = slug;
    var line;
    try {
      line = JSON.stringify(entry);
    } catch (e) {
      lastError = "unserializable_record";
      return { ok: false, reason: lastError };
    }
    // A single pathological record must not corrupt the stream for everything
    // that follows it.
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      lastError = "record_too_large";
      return { ok: false, reason: lastError };
    }
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fsImpl.appendFileSync(file, line + "\n", { encoding: "utf8", mode: 0o600 });
      lastError = null;
      return { ok: true, entry: entry };
    } catch (e) {
      lastError = "append_failed";
      return { ok: false, reason: lastError };
    }
  }

  // Reader for tests and the health projection. A corrupt line is skipped
  // rather than failing the whole read — the audit's value is that the rest of
  // the history stays legible.
  function read(limit) {
    if (!file) return [];
    var raw;
    try {
      raw = fsImpl.readFileSync(file, "utf8");
    } catch (e) {
      return [];
    }
    var lines = raw.split("\n");
    var entries = [];
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      try {
        var parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === "object") entries.push(parsed);
      } catch (e) {
        continue;
      }
    }
    var max = Number.isInteger(limit) && limit > 0 ? limit : 0;
    return max && entries.length > max ? entries.slice(entries.length - max) : entries;
  }

  return {
    append: append,
    file: file,
    lastError: function () { return lastError; },
    read: read,
  };
}

module.exports = {
  AUDIT_DIR: AUDIT_DIR,
  auditDir: auditDir,
  auditFileForProject: auditFileForProject,
  createAutomationAudit: createAutomationAudit,
  safeSlug: safeSlug,
};
