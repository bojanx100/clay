var matesModule = require("./mates");

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDebateNameMap(panelists, mateCtx) {
  var nameMap = {};
  for (var i = 0; i < panelists.length; i++) {
    var mate = matesModule.getMate(mateCtx, panelists[i].mateId);
    if (!mate) continue;
    var name = (mate.profile && mate.profile.displayName) || mate.name || "";
    if (name) {
      nameMap[name] = panelists[i].mateId;
    }
  }
  return nameMap;
}

function detectMentions(text, nameMap) {
  var names = Object.keys(nameMap);
  names.sort(function (a, b) { return b.length - a.length; });
  var mentioned = [];
  var cleaned = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*{1,3}|_{1,3}|~{2})/g, "");
  console.log("[debate-mention] nameMap keys:", JSON.stringify(names));
  console.log("[debate-mention] text snippet:", cleaned.slice(0, 200));
  for (var i = 0; i < names.length; i++) {
    var pattern = new RegExp("@" + escapeRegex(names[i]) + "(?![\\p{L}\\p{N}_-])", "iu");
    var matched = pattern.test(cleaned);
    console.log("[debate-mention] testing @" + names[i] + " pattern=" + pattern.toString() + " matched=" + matched);
    if (matched) {
      var mateId = nameMap[names[i]];
      if (mentioned.indexOf(mateId) === -1) {
        mentioned.push(mateId);
      }
    }
  }
  return mentioned;
}

function buildModeratorContext(ctx, debate) {
  var lines = [
    "You are moderating a structured debate among your AI teammates.",
    "",
    "Topic: " + debate.topic,
    "Format: " + debate.format,
    "Context: " + debate.context,
  ];
  if (debate.specialRequests) {
    lines.push("Special requests: " + debate.specialRequests);
  }
  lines.push("");
  lines.push("Panelists:");
  for (var i = 0; i < debate.panelists.length; i++) {
    var p = debate.panelists[i];
    var profile = ctx.getMateProfile(debate.mateCtx, p.mateId);
    lines.push("- @" + profile.name + " (" + p.role + "): " + p.brief);
  }
  lines.push("");
  lines.push("RULES:");
  lines.push("1. To call on a panelist, mention them with @TheirName in your response.");
  lines.push("2. Only mention ONE panelist per response. Wait for their answer before calling the next.");
  lines.push("3. When you mention a panelist, clearly state what you want them to address.");
  lines.push("4. After hearing from all panelists, you may start additional rounds.");
  lines.push("5. When you believe the debate has reached a natural conclusion, provide a summary WITHOUT mentioning any panelist. A response with no @mention signals the end of the debate.");
  lines.push("6. If the user interjects with a comment, acknowledge it and weave it into the discussion.");
  lines.push("");
  lines.push("Begin by introducing the topic and calling on the first panelist.");
  return lines.join("\n");
}

function buildPanelistContext(ctx, debate, panelistInfo) {
  var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);
  var lines = [
    "You are participating in a structured debate as a panelist.",
    "",
    "Topic: " + debate.topic,
    "Your role: " + panelistInfo.role,
    "Your brief: " + panelistInfo.brief,
    "",
    "Other panelists:",
  ];
  for (var i = 0; i < debate.panelists.length; i++) {
    var p = debate.panelists[i];
    if (p.mateId === panelistInfo.mateId) continue;
    var profile = ctx.getMateProfile(debate.mateCtx, p.mateId);
    lines.push("- @" + profile.name + " (" + p.role + "): " + p.brief);
  }
  lines.push("");
  lines.push("The moderator is @" + moderatorProfile.name + ". They will call on you when it is your turn.");
  lines.push("");
  lines.push("RULES:");
  lines.push("1. Stay in your assigned role and perspective.");
  lines.push("2. Respond to the specific question or prompt from the moderator.");
  lines.push("3. You may reference what other panelists have said.");
  lines.push("4. Keep responses focused and substantive. Do not ramble.");
  lines.push("5. You have read-only access to project files if needed to support your arguments.");
  return lines.join("\n");
}

function buildDebateToolHandler(session) {
  return function (toolName, input, toolOpts) {
    var autoAllow = { Read: true, Glob: true, Grep: true, WebFetch: true, WebSearch: true };
    if (autoAllow[toolName]) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }
    return Promise.resolve({
      behavior: "deny",
      message: "Read-only access during debate. You cannot make changes.",
    });
  };
}

module.exports = {
  buildDebateNameMap: buildDebateNameMap,
  detectMentions: detectMentions,
  buildModeratorContext: buildModeratorContext,
  buildPanelistContext: buildPanelistContext,
  buildDebateToolHandler: buildDebateToolHandler,
};
