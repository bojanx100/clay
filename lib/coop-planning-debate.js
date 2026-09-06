// Planning uses the debate transcript as its evidence. An ended provider turn,
// cancelled discussion, or missing panelist is not a completed plan.
var crypto = require("crypto");

function record(session) {
  return session && session.orchestrationPolicy && session.orchestrationPolicy.coopPlanning || null;
}

function missingPanelist(session) {
  var plan = record(session);
  return plan.panelists.find(function (panelist) {
    return !session.history.slice(plan.revisionStartIndex || 0).some(function (turn) {
      return turn.type === "debate_turn_done" && turn.mateId === panelist.mateId &&
        turn.role !== "moderator" && String(turn.text || "").trim();
    });
  });
}

function finish(ctx, session, reason) {
  var plan = record(session);
  if (!plan) return false;
  var conclusion = (session.history || []).slice(plan.revisionStartIndex || 0).filter(function (entry) {
    return entry.type === "debate_conclusion";
  }).pop();
  var text = String(conclusion && conclusion.text || "").trim();
  var ready = reason === "natural" && text.length <= 16000 && !missingPanelist(session) &&
    /RECOMMENDATION:\s*\S/.test(text) && /OPEN QUESTIONS:/.test(text);
  plan.status = ready ? "ready" : "attention";
  plan.reason = ready ? "" : reason === "natural" ? "incomplete_synthesis" : reason;
  plan.updatedAt = Date.now();
  delete plan.plan;
  delete plan.planDigest;
  if (ready) {
    plan.plan = text;
    plan.planDigest = crypto.createHash("sha256").update(text).digest("hex");
  }
  session.loop.active = false;
  plan.reportPending = true;
  var saved = ctx.sm.saveSessionFile(session, { durable: true }) === true;
  if (!saved) {
    session._coopPlanningFinishReason = reason;
    plan.status = "attention";
    plan.reason = "persistence_failed";
    delete plan.planDigest;
  } else {
    delete session._coopPlanningFinishReason;
    if (typeof ctx.onCoopPlanningFinished === "function") ctx.onCoopPlanningFinished(session);
  }
  var debate = session._debate;
  [debate && debate.moderatorSession].concat(Object.values(debate && debate.panelistSessions || {})).forEach(function (handle) {
    if (handle && handle.close) handle.close();
  });
  ctx.sm.broadcastSessionList();
  return true;
}

function interrupted(ctx, session) {
  var plan = record(session);
  if (!plan || ["starting", "running"].indexOf(plan.status) === -1) return;
  var before = JSON.parse(JSON.stringify(plan));
  var debateBefore = session.debateState;
  plan.status = "attention";
  plan.reason = "interrupted";
  plan.reportPending = true;
  if (session.loop) session.loop.active = false;
  var event = session.history.some(function (entry) { return entry.type === "debate_started"; }) ?
    { type: "debate_ended", topic: plan.question, reason: "interrupted", rounds: 0 } : null;
  if (event) session.history.push(event);
  if (session.debateState) session.debateState = Object.assign({}, session.debateState, { phase: "ended" });
  if (ctx.sm.saveSessionFile(session, { durable: true }) !== true) {
    session.orchestrationPolicy.coopPlanning = before;
    session.debateState = debateBefore;
    if (event) session.history.pop();
  }
}

function resume(ctx, session) {
  var plan = record(session);
  if (!plan) return true;
  if (plan.commissionDigest) return false;
  var before = JSON.parse(JSON.stringify(plan));
  plan.status = "running";
  plan.reason = "";
  plan.runVersion = (plan.runVersion || 1) + 1;
  plan.revisionStartIndex = session.history.length;
  plan.reportPending = false;
  delete plan.plan;
  delete plan.planDigest;
  if (ctx.sm.saveSessionFile(session, { durable: true }) !== true) {
    session.orchestrationPolicy.coopPlanning = before;
    return false;
  }
  session.loop.active = true;
  return true;
}

function currentGuard(session) {
  var plan = record(session);
  if (!plan) return null;
  var version = plan.runVersion || 1;
  return function () {
    return !session._deleted && record(session).runVersion === version && session._debate &&
      session._debate.phase !== "ended";
  };
}

module.exports = { record: record, missingPanelist: missingPanelist, finish: finish,
  interrupted: interrupted, resume: resume, currentGuard: currentGuard };
