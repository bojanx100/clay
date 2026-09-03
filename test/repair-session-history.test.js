var test = require("node:test");
var assert = require("node:assert");

var repair = require("../scripts/repair-session-history");

test("targeted history repair changes only generated and restart user rows", function() {
  var unchanged = JSON.stringify({ type: "delta", text: "preserve formatting", _ts: 1 });
  var generated = JSON.stringify({
    type: "user_message",
    text: "[Context from previous claude conversation]\n\nUser: old",
    _ts: 2,
  });
  var restart = JSON.stringify({
    type: "user_message",
    text: "Resume the work that was interrupted when Clay restarted. Continue from where " +
      "you left off; do not restart from scratch or re-ask for confirmation.",
    _ts: 3,
  });
  var real = JSON.stringify({
    type: "user_message",
    text: "Here is pasted [Context from previous claude conversation] for reference",
    _ts: 4,
  });
  var result = repair.repairContent([unchanged, generated, restart, real, ""].join("\n"));
  var rows = result.content.trim().split("\n").map(JSON.parse);

  assert.equal(result.changedFields, 6);
  assert.deepEqual(result.changedRows.map(function(row) { return row.fileLine; }), [2, 3]);
  assert.equal(result.content.split("\n")[0], unchanged, "unrelated line remains byte-identical");
  assert.equal(result.content.split("\n")[3], real, "real owner line remains byte-identical");
  assert.equal(rows[1].internalOnly, true);
  assert.equal(rows[1].synthetic, true);
  assert.deepEqual(rows[1].origin, { kind: "handoff-context" });
  assert.equal(rows[2].text, "↻ Resuming after restart");
  assert.equal(rows[2].synthetic, true);
  assert.equal(rows[2].autoAction, true);
});
