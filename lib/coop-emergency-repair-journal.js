// Small CAS journal for the emergency policy. Production callers must opt in
// with this durable store (or an equivalent transactional store); the policy
// refuses an in-memory journal so a restart can never forget a repair lease.

var fsModule = require("fs");
var path = require("path");
var schema = require("./coop-emergency-repair-schema");

function clone(value) {
  return schema.clone(value);
}

function journalError(code, message) {
  return schema.error(code, message);
}

function validateDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.version !== 1 || !value.records || typeof value.records !== "object" ||
      Array.isArray(value.records)) {
    throw journalError("EMERGENCY_REPAIR_JOURNAL_CORRUPT", "Emergency repair journal is invalid.");
  }
  return value;
}

function createMemoryJournal() {
  var records = Object.create(null);
  return {
    durable: false,
    read: function (repairId) { return records[repairId] ? clone(records[repairId]) : null; },
    compareAndSwap: function (repairId, expectedRevision, record) {
      var current = records[repairId] || null;
      var actual = current ? current.revision : null;
      if (actual !== expectedRevision) return { ok: false, current: current && clone(current) };
      records[repairId] = clone(record);
      return { ok: true, record: clone(record) };
    },
  };
}

function createFileJournal(options) {
  var opts = options || {};
  var fs = opts.fs || fsModule;
  if (typeof opts.file !== "string" || !opts.file.trim()) {
    throw journalError("EMERGENCY_REPAIR_JOURNAL_INVALID", "Emergency repair journal file is required.");
  }
  var file = path.resolve(opts.file);
  if (file === path.parse(file).root) {
    throw journalError("EMERGENCY_REPAIR_JOURNAL_INVALID", "Emergency repair journal file is required.");
  }
  var lock = file + ".lock";

  function document() {
    if (!fs.existsSync(file)) return { version: 1, records: {} };
    var raw = fs.readFileSync(file, "utf8");
    try { return validateDocument(JSON.parse(raw)); }
    catch (cause) {
      if (cause && cause.code) throw cause;
      throw journalError("EMERGENCY_REPAIR_JOURNAL_CORRUPT", "Emergency repair journal is not valid JSON.");
    }
  }

  function withLock(work) {
    var descriptor;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      descriptor = fs.openSync(lock, "wx", 0o600);
    } catch (cause) {
      throw journalError("EMERGENCY_REPAIR_JOURNAL_BUSY", "Emergency repair journal is busy.");
    }
    try { return work(); }
    finally {
      try { fs.closeSync(descriptor); } catch (closeError) {}
      try { fs.unlinkSync(lock); } catch (unlinkError) {}
    }
  }

  function write(documentValue) {
    var temp = file + ".tmp-" + process.pid + "-" + Date.now();
    var body = JSON.stringify(documentValue) + "\n";
    try {
      fs.writeFileSync(temp, body, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      if (fs.existsSync(temp)) {
        try { fs.unlinkSync(temp); } catch (cleanupError) {}
      }
    }
  }

  return {
    durable: true,
    read: function (repairId) {
      var value = document().records[repairId];
      return value ? clone(value) : null;
    },
    compareAndSwap: function (repairId, expectedRevision, record) {
      return withLock(function () {
        var currentDocument = document();
        var current = currentDocument.records[repairId] || null;
        var actual = current ? current.revision : null;
        if (actual !== expectedRevision) return { ok: false, current: current && clone(current) };
        currentDocument.records[repairId] = clone(record);
        write(currentDocument);
        return { ok: true, record: clone(record) };
      });
    },
  };
}

module.exports = {
  createFileJournal: createFileJournal,
  createMemoryJournal: createMemoryJournal,
};
