// Owner-gated priority persistence for the Coop control surface. The order is
// reference-only and stores only canonical Thread ids, beside the other durable
// Coop ledgers, so it survives browsers and daemon restarts.

var fs = require("fs");
var path = require("path");
var config = require("./config");
var ledgerFile = require("./coop-control-ledger-file");
var DEFAULT_FILE = path.join(config.CONFIG_DIR, "lead", "coop-owner-sidebar-priority.json");

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function cleanRecord(value) {
  var stored = value && typeof value === "object" ? value : {};
  return {
    revision: Number.isInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0,
    order: Array.isArray(stored.order) ? stored.order.filter(function (id) {
      return typeof id === "string" && id.length > 0 && id.length <= 128;
    }) : [],
    // Visibility is a projection preference keyed by immutable owner ingress
    // ids. It deliberately never mutates the request, Thread, task, session or
    // terminal-outcome stores, so Clear is archival and replay-safe.
    hidden: Array.isArray(stored.hidden) ? stored.hidden.filter(function (id, index, list) {
      return typeof id === "string" && id.length > 0 && id.length <= 256 &&
        list.indexOf(id) === index;
    }) : [],
  };
}

function readRecord(fsImpl, file) {
  try { return cleanRecord(JSON.parse(fsImpl.readFileSync(file, "utf8"))); }
  catch (error) { return cleanRecord(null); }
}

function priorityRecord(options) {
  var opts = options || {};
  return readRecord(opts.fs || fs, opts.file || DEFAULT_FILE);
}

function applyPriority(topicRef, direction, candidateRefs, options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || DEFAULT_FILE;
  var target = topicId(topicRef);
  var candidates = Array.isArray(candidateRefs) ? candidateRefs.map(topicId).filter(Boolean) : [];
  if (!target || candidates.indexOf(target) === -1 || (direction !== "earlier" && direction !== "later")) {
    return { ok: false, code: "invalid_priority_request" };
  }
  try {
    return ledgerFile.withLock(file, function () {
      var identity = ledgerFile.readIdentity(fsImpl, file);
      var state = readRecord(fsImpl, file);
      var order = state.order.filter(function (id) { return candidates.indexOf(id) === -1; });
      var current = state.order.filter(function (id) { return candidates.indexOf(id) !== -1; });
      for (var i = 0; i < candidates.length; i++) {
        if (current.indexOf(candidates[i]) === -1) current.push(candidates[i]);
      }
      var position = current.indexOf(target);
      var replacement = direction === "earlier" ? position - 1 : position + 1;
      if (replacement < 0 || replacement >= current.length) {
        return { ok: true, changed: false, priority: state };
      }
      var swapped = current[position];
      current[position] = current[replacement];
      current[replacement] = swapped;
      var saved = { revision: state.revision + 1, order: current.concat(order) };
      var committed = ledgerFile.commitJson(fsImpl, file, saved, identity);
      if (!committed.ok) return { ok: false, code: committed.code || "persistence_failed" };
      return { ok: true, changed: true, priority: cleanRecord(saved) };
    }, opts.lockOptions);
  } catch (error) {
    return { ok: false, code: "persistence_failed" };
  }
}

function applyVisibility(entryId, hide, entries, options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || DEFAULT_FILE;
  var id = typeof entryId === "string" ? entryId.trim() : "";
  var list = Array.isArray(entries) ? entries : [];
  var entry = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].entryId === id) { entry = list[i]; break; }
  }
  if (!id || !entry) return { ok: false, code: "unknown_owner_ledger_entry" };
  if (hide && entry.clearable !== true) return { ok: false, code: "entry_not_clearable" };
  try {
    return ledgerFile.withLock(file, function () {
      var identity = ledgerFile.readIdentity(fsImpl, file);
      var state = readRecord(fsImpl, file);
      var index = state.hidden.indexOf(id);
      if (hide && index !== -1 || !hide && index === -1) {
        return { ok: true, changed: false, priority: state };
      }
      var nextHidden = hide ? state.hidden.concat([id]) : state.hidden.filter(function (value) {
        return value !== id;
      });
      var saved = { revision: state.revision + 1, order: state.order, hidden: nextHidden };
      var committed = ledgerFile.commitJson(fsImpl, file, saved, identity);
      if (!committed.ok) return { ok: false, code: committed.code || "persistence_failed" };
      return { ok: true, changed: true, priority: cleanRecord(saved) };
    }, opts.lockOptions);
  } catch (error) {
    return { ok: false, code: "persistence_failed" };
  }
}

module.exports = { priorityRecord: priorityRecord, applyPriority: applyPriority,
  applyVisibility: applyVisibility };
