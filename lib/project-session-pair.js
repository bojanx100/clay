var pairMcp = require("./session-pair-mcp-server");
var yoke = require("./yoke");

var MAX_RESPONSE_CHARS = 30000;

function toolResult(value) {
  return Promise.resolve({ content: [{ type: "text", text: JSON.stringify(value) }] });
}

function toolError(err) {
  return Promise.resolve({
    content: [{ type: "text", text: "Error: " + (err.message || err) }],
    isError: true,
  });
}

function responseText(history, fromIndex) {
  var text = "";
  for (var i = Math.max(0, fromIndex || 0); i < history.length; i++) {
    if (history[i] && history[i].type === "delta" && history[i].text) text += history[i].text;
  }
  if (text.length > MAX_RESPONSE_CHARS) text = text.slice(-MAX_RESPONSE_CHARS);
  return text;
}

function errorSince(history, fromIndex) {
  for (var i = history.length - 1; i >= Math.max(0, fromIndex || 0); i--) {
    if (history[i] && history[i].type === "error") return history[i].text || "partner turn failed";
  }
  return null;
}

function recentTurns(session, count) {
  var history = session.history || [];
  var starts = [];
  for (var i = 0; i < history.length; i++) {
    if (history[i] && history[i].type === "user_message") starts.push(i);
  }
  var from = starts.length > 0 ? starts[Math.max(0, starts.length - count)] : 0;
  var turns = [];
  var current = null;
  for (var j = from; j < history.length; j++) {
    var item = history[j];
    if (!item) continue;
    if (item.type === "user_message") {
      current = { user: item.text || "", delegated: !!item.delegated, response: "" };
      turns.push(current);
    } else if (item.type === "delta" && item.text) {
      if (!current) { current = { user: "", delegated: false, response: "" }; turns.push(current); }
      current.response += item.text;
      if (current.response.length > MAX_RESPONSE_CHARS) current.response = current.response.slice(-MAX_RESPONSE_CHARS);
    }
  }
  return turns;
}

function attachSessionPair(ctx) {
  var sm = ctx.sm;
  var store = ctx.splitStore;

  function groupAndPartner(caller) {
    if (!caller) throw new Error("partner tools require a session-bound tool server");
    var group = store.groupForMember(caller.localId);
    if (!group) throw new Error("this session is not in a split group");
    if (group.pair && group.pair.driverId !== caller.localId) {
      throw new Error("only the configured Driver can direct this pair");
    }
    var partnerId = group.members[0] === caller.localId ? group.members[1] : group.members[0];
    var partner = sm.sessions.get(partnerId);
    if (!partner) throw new Error("split partner session was not found");
    if (caller.ownerId !== partner.ownerId) throw new Error("split partner access denied");
    return { group: group, partner: partner };
  }

  function broadcastDelegation(group, caller, partner, active) {
    var message = {
      type: "split_delegation",
      groupId: group.id,
      from: caller.localId,
      to: partner.localId,
      active: !!active,
    };
    if (typeof ctx.broadcastDelegation === "function") ctx.broadcastDelegation(group, message);
    else ctx.send(message);
  }

  function finishDelegation(group, caller, partner, token) {
    if (partner._pairDelegation !== token) return;
    delete partner._pairDelegation;
    delete partner._delegatedBy;
    broadcastDelegation(group, caller, partner, false);
  }

  function waitForPartner(group, caller, partner, token, timeoutSeconds) {
    return new Promise(function (resolve, reject) {
      var deadline = Date.now() + timeoutSeconds * 1000;
      var timer = setInterval(function () {
        var currentGroup = store.groupForMember(caller.localId);
        if (!currentGroup || currentGroup.id !== group.id || currentGroup.members.indexOf(partner.localId) === -1) {
          clearInterval(timer);
          finishDelegation(group, caller, partner, token);
          reject(new Error("the split group was dissolved while waiting for the partner"));
          return;
        }
        if (!partner.isProcessing && !partner._queryStarting) {
          clearInterval(timer);
          finishDelegation(group, caller, partner, token);
          var failure = errorSince(partner.history || [], token.startIndex);
          resolve({
            status: failure ? "error" : "complete",
            response: responseText(partner.history || [], token.startIndex),
            error: failure || undefined,
          });
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(timer);
          monitorPartner(group, caller, partner, token);
          resolve({ status: "running", response: responseText(partner.history || [], token.startIndex), hint: "Use read_partner to check again." });
        }
      }, 500);
    });
  }

  function monitorPartner(group, caller, partner, token) {
    var timer = setInterval(function () {
      var currentGroup = store.groupForMember(caller.localId);
      if (!currentGroup || currentGroup.id !== group.id || (!partner.isProcessing && !partner._queryStarting)) {
        clearInterval(timer);
        finishDelegation(group, caller, partner, token);
      }
    }, 500);
  }

  async function sendToPartner(args, caller) {
    try {
      if (caller && caller._delegatedBy) throw new Error("delegated turns cannot delegate to another session");
      var resolved = groupAndPartner(caller);
      var message = typeof args.message === "string" ? args.message.trim() : "";
      if (!message) throw new Error("message is required");
      var wait = args.wait !== false;
      var timeout = Number.isFinite(args.timeoutSeconds) ? Math.floor(args.timeoutSeconds) : 300;
      timeout = Math.max(1, Math.min(900, timeout));
      var partner = resolved.partner;
      if (partner._pairDelegation) throw new Error("the partner is already handling a delegated task");
      var token = { from: caller.localId, groupId: resolved.group.id, startIndex: partner.history.length };
      partner._pairDelegation = token;
      partner._delegatedBy = caller.localId;
      sm.sendAndRecord(partner, {
        type: "user_message",
        text: message,
        delegated: true,
        delegatedBy: caller.localId,
        delegatedByTitle: caller.title || "Driver",
        delegatedByVendor: caller.vendor || "claude",
      });
      partner.lastActivity = Date.now();
      partner.sentToolResults = {};
      broadcastDelegation(resolved.group, caller, partner, true);
      var sdk = ctx.getSdk();
      if (!sdk) throw new Error("SDK bridge is not ready");
      if (!partner.isProcessing) {
        partner.isProcessing = true;
        ctx.onProcessingChanged();
        sm.sendToSession(partner, { type: "status", status: "processing" });
      }
      if (!sdk.pushMessage(partner, message)) {
        partner._queryStartTs = Date.now();
        Promise.resolve(sdk.startQuery(partner, message, undefined, ctx.getLinuxUserForSession(partner))).catch(function (err) {
          partner.isProcessing = false;
          sm.sendAndRecord(partner, { type: "error", text: err.message || String(err) });
        });
      }
      sm.broadcastSessionList();
      if (!wait) {
        monitorPartner(resolved.group, caller, partner, token);
        return toolResult({ status: "running", partnerId: partner.localId, hint: "Use read_partner to check progress." });
      }
      return toolResult(await waitForPartner(resolved.group, caller, partner, token, timeout));
    } catch (e) {
      if (caller) {
        var group = store.groupForMember(caller.localId);
        if (group) {
          var partnerId = group.members[0] === caller.localId ? group.members[1] : group.members[0];
          var partner = sm.sessions.get(partnerId);
          if (partner && partner._pairDelegation && partner._pairDelegation.from === caller.localId && !partner.isProcessing) {
            finishDelegation(group, caller, partner, partner._pairDelegation);
          }
        }
      }
      return toolError(e);
    }
  }

  function readPartner(args, caller) {
    try {
      var resolved = groupAndPartner(caller);
      var count = Number.isFinite(args.lastTurns) ? Math.floor(args.lastTurns) : 1;
      count = Math.max(1, Math.min(5, count));
      return toolResult({
        status: resolved.partner.isProcessing ? "running" : "idle",
        partnerId: resolved.partner.localId,
        title: resolved.partner.title || "New Session",
        turns: recentTurns(resolved.partner, count),
      });
    } catch (e) {
      return toolError(e);
    }
  }

  function getToolDefs(boundSession) {
    if (!boundSession) return pairMcp.getToolDefs({
      send: function () { return toolError(new Error("send_to_partner requires a session-bound tool server")); },
      read: function () { return toolError(new Error("read_partner requires a session-bound tool server")); },
    });
    // Mount whenever we have a bound session: MCP servers are fixed for the
    // lifetime of a query, and Claude queries live across turns, so gating on
    // group membership HERE would permanently hide the tools from a session
    // whose split is created mid-conversation (the ad-hoc flow). Handlers
    // re-resolve the group on every call, so an ungrouped session gets a
    // clear error, and a session that gains a partner later just works.
    // The one structural exclusion: a session that is ALREADY a configured
    // pair worker at query start never sees the tools.
    var group = store.groupForMember(boundSession.localId);
    if (group && group.pair && group.pair.driverId !== boundSession.localId) return [];
    return pairMcp.getToolDefs({
      send: function (args) { return sendToPartner(args, boundSession); },
      read: function (args) { return readPartner(args, boundSession); },
    });
  }

  function validateVendor(vendor) {
    var installed = sm.installedVendors || [];
    if (!vendor || installed.indexOf(vendor) === -1) throw new Error("vendor is not installed: " + (vendor || "unknown"));
    return vendor;
  }

  function createPair(ws, msg) {
    try {
      if (ctx.isMate) throw new Error("Pair sessions are only available in projects");
      var driverSpec = msg.driver || {};
      var workerSpec = msg.worker || {};
      var workerVendor = validateVendor(workerSpec.vendor || sm.lastVendor || "codex");
      var ownerId = ws._clayUser && ctx.usersModule.isMultiUser() ? ws._clayUser.id : null;
      var driver;
      var groupName;
      if (Number.isInteger(driverSpec.sessionId)) {
        // "Add Worker" on an existing session: the current session becomes
        // the Driver with its full conversation context intact.
        driver = sm.sessions.get(driverSpec.sessionId);
        if (!driver) throw new Error("driver session not found");
        if ((driver.ownerId || null) !== ownerId) throw new Error("driver session access denied");
        if (store.groupForMember(driver.localId)) throw new Error("this session is already in a split group");
        groupName = undefined; // auto name from member titles
      } else {
        var driverVendor = validateVendor(driverSpec.vendor || "claude");
        var driverEffort = yoke.clampEffort(driverVendor, driverSpec.effort || (sm.currentEffortByVendor && sm.currentEffortByVendor[driverVendor]) || sm.currentEffort || "medium") || null;
        driver = sm.createSessionRaw({ ownerId: ownerId, vendor: driverVendor, model: driverSpec.model || null, effort: driverEffort });
        driver.title = "Driver · " + ((yoke.getVendorInfo(driverVendor) || {}).displayName || driverVendor);
        if (driverSpec.effort) driver.loopSettings = { effort: driverSpec.effort };
        groupName = "Agent pair";
      }
      var workerEffort = yoke.clampEffort(workerVendor, workerSpec.effort || (sm.currentEffortByVendor && sm.currentEffortByVendor[workerVendor]) || sm.currentEffort || "medium") || null;
      var worker = sm.createSessionRaw({ ownerId: ownerId, vendor: workerVendor, model: workerSpec.model || null, effort: workerEffort });
      worker.title = "Worker · " + ((yoke.getVendorInfo(workerVendor) || {}).displayName || workerVendor);
      if (workerSpec.effort) worker.loopSettings = { effort: workerSpec.effort };
      var result = store.create(ws, {
        members: [driver.localId, worker.localId],
        pair: { driverId: driver.localId, workerId: worker.localId },
        name: groupName,
      });
      if (!result.ok) throw new Error(result.error);
      sm.broadcastSessionList();
      ctx.sendTo(ws, { type: "pair_session_created", ok: true, group: result.group });
    } catch (e) {
      ctx.sendTo(ws, { type: "pair_session_created", ok: false, error: e.message || String(e) });
    }
  }

  function handleMessage(ws, msg) {
    if (msg.type === "pair_session_options") {
      if (ctx.isMate) return false;
      ctx.sendTo(ws, {
        type: "pair_session_options",
        installedVendors: sm.installedVendors || [],
        modelsByVendor: sm.modelsByVendor || {},
        capabilitiesByVendor: sm.capabilitiesByVendor || {},
        lastVendor: sm.lastVendor || null,
      });
      return true;
    }
    if (msg.type === "pair_session_create") {
      createPair(ws, msg);
      return true;
    }
    return false;
  }

  function getSystemPrompt(session) {
    var group = store.groupForMember(session.localId);
    if (!group || !group.pair || group.pair.driverId !== session.localId) return "";
    return "You are the Driver in a two-agent pair. Plan the work, delegate concrete bounded tasks with send_to_partner, inspect results with read_partner, then integrate and verify the final outcome. Do not delegate work that must be performed sequentially in this same session.";
  }

  return { getToolDefs: getToolDefs, handleMessage: handleMessage, getSystemPrompt: getSystemPrompt };
}

module.exports = {
  attachSessionPair: attachSessionPair,
  responseText: responseText,
  recentTurns: recentTurns,
};
