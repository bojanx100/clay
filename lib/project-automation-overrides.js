// project-automation-overrides.js - The owner's explicit, durable word about
// one specific item, and the only thing that outranks the automatic rules.
//
// Automatic pickup is deliberately narrow: it runs the owner's OWN assigned
// board work, and nothing else. That rule is right for the steady state and
// wrong for the exceptions, which are real — "run this one even though it is
// not assigned to me", and "never touch this one, whatever the rules say".
//
// Those exceptions belong in owner data, not in code. trialview/v2#2539 was an
// unassigned issue the owner later authorized as a one-off; encoding that as a
// special case in the eligibility rules would have made a permanent hole out of
// a single decision, and the next exception would have made another. So the
// exception lives here, as a typed record naming the item, the decision, who
// made it and when — visible, auditable, and revocable.
//
// PRECEDENCE, AND WHAT AN OVERRIDE DOES NOT DO.
//
//   exclude  beats everything, including include. A refusal is always
//            honorable, so the ambiguous case (both recorded) resolves to the
//            safe direction rather than to whichever was written last.
//   include  waives THE ASSIGNMENT REQUIREMENT ONLY.
//
// An include is not an approval, not a claim, and not a bypass. Work the
// project's own policy sends to the owner still goes to the owner; work that is
// already running is still deduplicated; a PR-backed or in-flight item is still
// skipped. Those gates exist for reasons unrelated to who the item is assigned
// to, and an include says nothing about them. Anything else would turn one
// narrow exception into a general-purpose override of every safety rule at once.

var fs = require("fs");
var path = require("path");

var SCHEMA = "clay.automation_overrides";
var SCHEMA_VERSION = 1;
var MAX_OVERRIDES = 1024;

var INCLUDE = "include";
var EXCLUDE = "exclude";

function defaultFile(cwd) {
  return path.join(cwd, ".clay", "tasks", "automation-overrides.json");
}

function clone(value) {
  return value === undefined || value === null ? null : JSON.parse(JSON.stringify(value));
}

function normalizeKey(itemKey) {
  return String(itemKey == null ? "" : itemKey).trim();
}

function createOverrideStore(options) {
  var opts = options || {};
  var fsImpl = opts.fs || fs;
  var file = opts.file || defaultFile(opts.cwd || ".");
  var now = opts.now || Date.now;

  // Fail-closed read. A corrupt override file must never read as "no overrides":
  // that would silently drop an owner's EXCLUDE and let automation start work
  // the owner explicitly forbade.
  function read() {
    try {
      var parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      if (!parsed || parsed.schema !== SCHEMA || !Array.isArray(parsed.overrides)) {
        return { ok: false, reason: "malformed_state", overrides: [] };
      }
      return { ok: true, overrides: parsed.overrides };
    } catch (e) {
      if (e && e.code === "ENOENT") return { ok: true, overrides: [] };
      return { ok: false, reason: "malformed_state", overrides: [] };
    }
  }

  function write(overrides) {
    var temp = file + ".tmp." + process.pid;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(temp, JSON.stringify({
        schema: SCHEMA, version: SCHEMA_VERSION, overrides: overrides,
      }, null, 2) + "\n");
      fsImpl.renameSync(temp, file);
      return { ok: true };
    } catch (e) {
      try { fsImpl.unlinkSync(temp); } catch (unlinkError) {}
      return { ok: false, reason: "persistence_failed", error: e && e.message };
    }
  }

  function indexOf(overrides, itemKey) {
    for (var i = 0; i < overrides.length; i++) {
      if (overrides[i] && overrides[i].itemKey === itemKey) return i;
    }
    return -1;
  }

  // set -> { ok, override } | { ok:false, reason }
  // An override is an OWNER act, so it is refused without an owner identity —
  // an unattributable exception is not one anybody can later review.
  function set(itemKey, decision, details) {
    var key = normalizeKey(itemKey);
    if (!key) return { ok: false, reason: "invalid_item_key" };
    if (decision !== INCLUDE && decision !== EXCLUDE) {
      return { ok: false, reason: "invalid_decision" };
    }
    var info = details || {};
    var by = typeof info.by === "string" ? info.by.trim() : "";
    if (!by) return { ok: false, reason: "owner_identity_required" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var record = {
      itemKey: key,
      decision: decision,
      by: by,
      reason: typeof info.reason === "string" ? info.reason : "",
      at: now(),
    };
    var index = indexOf(state.overrides, key);
    if (index === -1) {
      if (state.overrides.length >= MAX_OVERRIDES) {
        return { ok: false, reason: "override_store_full" };
      }
      state.overrides.push(record);
    } else {
      record.firstAt = state.overrides[index].firstAt || state.overrides[index].at;
      state.overrides[index] = record;
    }
    var written = write(state.overrides);
    return written.ok ? { ok: true, override: clone(record) } : written;
  }

  function clear(itemKey) {
    var key = normalizeKey(itemKey);
    if (!key) return { ok: false, reason: "invalid_item_key" };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason };
    var index = indexOf(state.overrides, key);
    if (index === -1) return { ok: true, cleared: false };
    state.overrides.splice(index, 1);
    var written = write(state.overrides);
    return written.ok ? { ok: true, cleared: true } : written;
  }

  function list() {
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, overrides: [] };
    return { ok: true, overrides: clone(state.overrides) };
  }

  // decisionFor -> { ok, decision } | { ok:false, reason }
  //   decision: "include" | "exclude" | null
  // A read failure is reported rather than answered, so the caller can fail
  // closed instead of acting on an override file it could not actually read.
  function decisionFor(itemKey) {
    var key = normalizeKey(itemKey);
    if (!key) return { ok: true, decision: null };
    var state = read();
    if (!state.ok) return { ok: false, reason: state.reason, decision: null };
    var index = indexOf(state.overrides, key);
    if (index === -1) return { ok: true, decision: null };
    var decision = state.overrides[index].decision;
    if (decision !== INCLUDE && decision !== EXCLUDE) {
      // A record we cannot interpret is treated as a refusal, never as
      // permission: an unreadable exception must not widen what may run.
      return { ok: true, decision: EXCLUDE, malformed: true };
    }
    return { ok: true, decision: decision, override: clone(state.overrides[index]) };
  }

  // The whole eligibility question this module answers, in one call.
  //
  // eligibility(itemKey, assignedToOwner) ->
  //   { ok, eligible, reason, decision }
  //
  // `assignedToOwner` must be a proven boolean from the fetch layer. Anything
  // other than true means ownership was not established.
  function eligibility(itemKey, assignedToOwner) {
    var found = decisionFor(itemKey);
    if (!found.ok) {
      // Cannot read the owner's instructions, so we do not get to guess at
      // them. Nothing runs.
      return { ok: false, reason: found.reason, eligible: false, decision: null };
    }
    if (found.decision === EXCLUDE) {
      return { ok: true, eligible: false, reason: "owner_excluded", decision: EXCLUDE };
    }
    if (assignedToOwner === true) {
      return { ok: true, eligible: true, reason: "assigned_to_owner", decision: found.decision || null };
    }
    if (found.decision === INCLUDE) {
      // The one thing an include does: it stands in for assignment, and only
      // for assignment. Every other gate still applies downstream.
      return { ok: true, eligible: true, reason: "owner_included", decision: INCLUDE };
    }
    return { ok: true, eligible: false, reason: "not_assigned_to_owner", decision: null };
  }

  return {
    EXCLUDE: EXCLUDE,
    INCLUDE: INCLUDE,
    clear: clear,
    decisionFor: decisionFor,
    eligibility: eligibility,
    file: file,
    list: list,
    set: set,
  };
}

module.exports = {
  EXCLUDE: EXCLUDE,
  INCLUDE: INCLUDE,
  MAX_OVERRIDES: MAX_OVERRIDES,
  SCHEMA: SCHEMA,
  createOverrideStore: createOverrideStore,
  defaultFile: defaultFile,
};
