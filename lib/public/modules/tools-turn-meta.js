var ctx;
var deps = {};
var _lastCumulativeCost = 0;

export function initTurnMetaTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

function closeToolGroup() {
  if (deps.closeToolGroup) deps.closeToolGroup();
}

export function resetTurnMetaCost() {
  _lastCumulativeCost = 0;
}

export function addTurnMeta(cost, duration) {
  closeToolGroup();
  var div = document.createElement("div");
  div.className = "turn-meta";
  div.dataset.turn = ctx.turnCounter;
  var parts = [];
  if (cost != null) {
    var delta = cost - _lastCumulativeCost;
    if (delta < 0) delta = cost;
    _lastCumulativeCost = cost;
    var deltaStr = delta > 0 ? "+$" + delta.toFixed(4) : "$0.0000";
    parts.push(deltaStr + " \u2192 $" + cost.toFixed(4));
  }
  if (duration != null) parts.push((duration / 1000).toFixed(1) + "s");
  if (parts.length) {
    div.textContent = parts.join(" \u00b7 ");
    ctx.addToMessages(div);
    maybeScrollToBottom();
  }
}

export function saveTurnMetaState() {
  return {
    lastCumulativeCost: _lastCumulativeCost,
  };
}

export function restoreTurnMetaState(saved) {
  _lastCumulativeCost = saved.lastCumulativeCost || 0;
}
