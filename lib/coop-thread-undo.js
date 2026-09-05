// Reverse only the fields owned by a recorded action. Validate every affected
// Thread before changing any of them, so a conflicting multi-Thread correction
// cannot partially undo newer conversation or execution state.
var same = require("node:util").isDeepStrictEqual;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function idOf(thread) {
  var ref = thread && (thread.threadRef || thread.topicRef);
  return ref && (ref.threadId || ref.topicId) || "";
}

function withoutTimestamp(value) {
  var copy = Object.assign({}, value);
  delete copy.updatedAt;
  return copy;
}

function restoreSnapshots(topics, before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return { ok: false, code: "thread_undo_conflict" };
  }
  var entries = new Map();
  var invalid = false;
  [["before", before], ["after", after]].forEach(function (pair) {
    pair[1].forEach(function (snapshot) {
      var id = idOf(snapshot);
      if (!id) { invalid = true; return; }
      var entry = entries.get(id) || { id: id };
      if (entry[pair[0]]) { invalid = true; return; }
      entry[pair[0]] = snapshot;
      entries.set(id, entry);
    });
  });
  var plans = [];
  entries.forEach(function (entry) {
    var current = topics[entry.id];
    if (!entry.before || !entry.after) {
      if (entry.after ? !current || !same(withoutTimestamp(current), withoutTimestamp(entry.after)) : !!current) {
        invalid = true;
      }
      plans.push({ id: entry.id, replace: true, value: clone(entry.before) });
      return;
    }
    if (!current) { invalid = true; return; }
    var fields = Object.keys(Object.assign({}, entry.before, entry.after)).filter(function (key) {
      return key !== "updatedAt" && !same(entry.before[key], entry.after[key]);
    });
    for (var i = 0; i < fields.length; i++) {
      if (!same(current[fields[i]], entry.after[fields[i]])) invalid = true;
    }
    plans.push({ id: entry.id, fields: fields, value: entry.before });
  });
  if (invalid) return { ok: false, code: "thread_undo_conflict" };
  plans.forEach(function (plan) {
    if (plan.replace) {
      if (plan.value) topics[plan.id] = plan.value;
      else delete topics[plan.id];
      return;
    }
    plan.fields.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(plan.value, field)) {
        topics[plan.id][field] = clone(plan.value[field]);
      } else delete topics[plan.id][field];
    });
  });
  return { ok: true };
}

module.exports = { restoreSnapshots: restoreSnapshots };
