var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var matesModule = require("./mates");
var debateUtils = require("./project-debate-utils");
var buildDebateNameMap = debateUtils.buildDebateNameMap;
var resolveMateId = debateUtils.resolveMateId;
var pickFallbackModerator = debateUtils.pickFallbackModerator;
var detectMentions = debateUtils.detectMentions;
var buildModeratorContext = debateUtils.buildModeratorContext;
var buildPanelistContext = debateUtils.buildPanelistContext;
var buildDebateToolHandler = debateUtils.buildDebateToolHandler;
var debateFlow = require("./project-debate-flow");
var debateState = require("./project-debate-state");
var coopPlanning = require("./coop-planning-debate");

/**
 * Attach debate engine to a project context.
 *
 * ctx fields:
 *   cwd, slug, send, sendTo, sendToSession, sm, sdk,
 *   getMateProfile, loadMateClaudeMd, loadMateDigests,
 *   hydrateImageRefs, onProcessingChanged, getLinuxUserForSession, getSessionForWs,
 *   updateMemorySummary, initMemorySummary, enqueueDigest
 */
function attachDebate(ctx) {

  // For mate projects, enforce latest debate awareness prompt in CLAUDE.md
  // so mates use the propose_debate MCP tool instead of writing files.
  if (ctx.isMate) {
    var _debateClaudeMdPath = path.join(ctx.cwd, "CLAUDE.md");
    try { matesModule.enforceDebateAwareness(_debateClaudeMdPath); } catch (e) {}
  }

  // --- State persistence ---

  function persistDebateState(session) {
    if (!session._debate) return;
    var d = session._debate;
    session.debateState = {
      phase: d.phase,
      topic: d.topic,
      format: d.format,
      context: d.context || "",
      specialRequests: d.specialRequests || null,
      moderatorId: d.moderatorId,
      panelists: d.panelists.map(function (p) {
        return { mateId: p.mateId, role: p.role || "", brief: p.brief || "" };
      }),
      briefPath: d.briefPath || null,
      debateId: d.debateId || null,
      setupSessionId: d.setupSessionId || null,
      setupStartedAt: d.setupStartedAt || null,
      round: d.round || 1,
      awaitingConcludeConfirm: !!d.awaitingConcludeConfirm,
      awaitingUserFloor: !!d.awaitingUserFloor,
      ownerId: d.ownerId || null,
    };
    ctx.sm.saveSessionFile(session);
  }

  function restoreDebateFromState(session, restoreUserId) {
    var ds = session.debateState;
    if (!ds) return null;
    var userId = restoreUserId || ds.ownerId || null;
    var mateCtx = matesModule.buildMateCtx(userId);
    var debate = debateState.createDebateState({
      phase: ds.phase,
      topic: ds.topic,
      format: ds.format,
      context: ds.context || "",
      specialRequests: ds.specialRequests || null,
      moderatorId: ds.moderatorId,
      panelists: ds.panelists || [],
      mateCtx: mateCtx,
      nameMap: buildDebateNameMap(ds.panelists || [], mateCtx),
      round: ds.round || 1,
      setupSessionId: ds.setupSessionId || null,
      debateId: ds.debateId || null,
      setupStartedAt: ds.setupStartedAt || null,
      briefPath: ds.briefPath || null,
      ownerId: ds.ownerId || userId,
    });
    debate.awaitingConcludeConfirm = !!ds.awaitingConcludeConfirm;
    debate.awaitingUserFloor = !!ds.awaitingUserFloor;

    // Fallback: if awaitingConcludeConfirm was not persisted, detect from history
    if (debateFlow.inferAwaitingConcludeConfirm(debate, session.history, detectMentions)) {
      debate.awaitingConcludeConfirm = true;
    }

    session._debate = debate;
    return debate;
  }

  // --- Brief watcher ---

  function readDebateBrief(briefPath) {
    try {
      return { value: JSON.parse(fs.readFileSync(briefPath, "utf8")) };
    } catch (e) {
      return null;
    }
  }

  function stopDebateBriefWatcher(debate) {
    if (debate._briefWatcher) { debate._briefWatcher.close(); debate._briefWatcher = null; }
    if (debate._briefDebounce) { clearTimeout(debate._briefDebounce); debate._briefDebounce = null; }
  }

  function applyDebateBrief(debate, brief) {
    debate.topic = brief.topic || debate.topic;
    debate.format = brief.format || debate.format;
    debate.context = brief.context || "";
    debate.specialRequests = brief.specialRequests || null;
    if (brief.panelists && brief.panelists.length) {
      debate.panelists = debateState.panelistsFromBrief(brief.panelists);
    }
    var mateCtx = debate.mateCtx || matesModule.buildMateCtx(null);
    debate.nameMap = buildDebateNameMap(debate.panelists, mateCtx);
  }

  function sendDebateBriefReady(session, debate) {
    var mateCtx = debate.mateCtx || matesModule.buildMateCtx(null);
    var moderatorProfile = ctx.getMateProfile(mateCtx, debate.moderatorId);
    var briefReadyMsg = {
      type: "debate_brief_ready",
      debateId: debate.debateId,
      topic: debate.topic,
      format: debate.format || "free_discussion",
      context: debate.context || "",
      specialRequests: debate.specialRequests || null,
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name, role: p.role || "", brief: p.brief || "" };
      }),
    };
    ctx.sendToSession(session.localId, briefReadyMsg);
    if (debate.setupSessionId && debate.setupSessionId !== session.localId) {
      ctx.sendToSession(debate.setupSessionId, briefReadyMsg);
    }
  }

  function startDebateBriefWatcher(session, debate, briefPath) {
    if (!briefPath) {
      console.error("[debate] No briefPath provided to watcher");
      return;
    }
    // Persist briefPath on debate so restoration can reuse it
    debate.briefPath = briefPath;
    var watchDir = path.dirname(briefPath);
    var briefFilename = path.basename(briefPath);

    // Clean up any existing watcher
    if (debate._briefWatcher) {
      try { debate._briefWatcher.close(); } catch (e) {}
      debate._briefWatcher = null;
    }
    if (debate._briefDebounce) {
      clearTimeout(debate._briefDebounce);
      debate._briefDebounce = null;
    }

    function checkDebateBrief() {
      var result = readDebateBrief(briefPath);
      if (!result) return;
      try {
        stopDebateBriefWatcher(debate);
        try { fs.unlinkSync(briefPath); } catch (e) {}
        applyDebateBrief(debate, result.value);
        if (!debate.setupSessionId || debate.quickStart) {
          console.log("[debate] Brief picked up, entering review phase. Topic:", debate.topic);
          debate.phase = "reviewing";
          persistDebateState(session);
          sendDebateBriefReady(session, debate);
          return;
        }
        console.log("[debate] Brief picked up, transitioning to live. Topic:", debate.topic);
        startDebateLive(session);
      } catch (e) {
        // File not ready yet or invalid JSON, keep watching
      }
    }

    try {
      try { fs.mkdirSync(watchDir, { recursive: true }); } catch (e) {}
      debate._briefWatcher = fs.watch(watchDir, function (eventType, filename) {
        if (filename === briefFilename) {
          if (debate._briefDebounce) clearTimeout(debate._briefDebounce);
          debate._briefDebounce = setTimeout(checkDebateBrief, 300);
        }
      });
      debate._briefWatcher.on("error", function () {});
      console.log("[debate] Watching for " + briefFilename + " at " + watchDir);
    } catch (e) {
      console.error("[debate] Failed to watch " + watchDir + ":", e.message);
    }

    // Check immediately in case the file already exists (server restart scenario)
    checkDebateBrief();
  }

  // --- Restore debate on reconnect ---

  function restoreDebateState(ws) {
    // On server restart, SDK mention sessions are lost so debates cannot
    // continue — clear the PERSISTED state so dead debate UI is not
    // restored. This runs on every client connection, so it must never
    // touch a LIVE in-memory debate: deleting session._debate here killed
    // running debates on any reconnect blip (F-9, 2026-08-01) — the turn
    // chain kept running on captured closures while every user control
    // (pause, hand raise, stop) silently no-oped against the missing state.
    ctx.sm.sessions.forEach(function (session) {
      if (session._debate) return; // live debate — leave it alone
      if (coopPlanning.record(session)) { coopPlanning.interrupted(ctx, session); return; }
      if (session.debateState) {
        var phase = session.debateState.phase;
        if (phase === "preparing" || phase === "reviewing" || phase === "live") {
          console.log("[debate] Clearing stale debate state:", session.debateState.topic);
          session.debateState = null;
          ctx.sm.saveSessionFile(session);
        }
      }
    });
  }

  // --- Check for DM debate brief ---

  function findDmDebateBrief(debatesDir) {
    var dirs;
    try {
      dirs = fs.readdirSync(debatesDir);
    } catch (e) {
      return null;
    }
    for (var i = 0; i < dirs.length; i++) {
      var briefPath = path.join(debatesDir, dirs[i], "brief.json");
      var result = readDebateBrief(briefPath);
      if (result) return { debateId: dirs[i], briefPath: briefPath, brief: result.value };
    }
    return null;
  }

  function sendDmDebateBriefReady(session, debate, mateCtx) {
    var moderatorProfile = ctx.getMateProfile(mateCtx, debate.moderatorId);
    ctx.sendToSession(session.localId, {
      type: "debate_brief_ready",
      debateId: debate.debateId,
      topic: debate.topic,
      format: debate.format,
      context: debate.context,
      specialRequests: debate.specialRequests,
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name, role: p.role || "", brief: p.brief || "" };
      }),
    });
  }

  function checkForDmDebateBrief(session, mateId, mateCtx) {
    // Skip if there's already an active debate on this session
    if (session._debate && debateFlow.isActiveDebatePhase(session._debate.phase)) return;

    var debatesDir = path.join(ctx.cwd, ".clay", "debates");
    var found = findDmDebateBrief(debatesDir);
    if (!found) return;
    var brief = found.brief;
    var debateId = found.debateId;
    var briefPath = found.briefPath;
    console.log("[debate] Found DM debate brief from mate " + mateId + ", debateId:", debateId);
    try { fs.unlinkSync(briefPath); } catch (e) {}

    var debate = debateState.createDebateState({
      phase: "reviewing",
      topic: brief.topic || "Untitled debate",
      format: brief.format || "free_discussion",
      context: brief.context || "",
      specialRequests: brief.specialRequests || null,
      moderatorId: mateId,
      panelists: debateState.panelistsFromBrief(brief.panelists),
      mateCtx: mateCtx,
      debateId: debateId,
      briefPath: briefPath,
      ownerId: mateCtx.userId || null,
    });
    debate.nameMap = buildDebateNameMap(debate.panelists, mateCtx);
    session._debate = debate;
    persistDebateState(session);
    sendDmDebateBriefReady(session, debate, mateCtx);
  }

  // --- Main debate handlers ---

  function populateDelegatedPanelists(ws, msg) {
    var userId = ws._clayUser ? ws._clayUser.id : null;
    var tmpCtx = matesModule.buildMateCtx(userId);
    var matesData = matesModule.loadMates(tmpCtx);
    var allMates = matesData.mates || [];
    msg.panelists = [];
    for (var i = 0; i < allMates.length; i++) {
      if (allMates[i].id !== msg.moderatorId && allMates[i].status !== "interviewing") {
        msg.panelists.push({ mateId: allMates[i].id, role: "", brief: "" });
      }
    }
  }

  function prepareDebateStart(ws, msg, session) {
    if (!msg.moderatorId || !msg.topic) {
      return { ok: false, error: "Missing required fields: moderatorId, topic." };
    }
    if (msg.delegatePanelists) populateDelegatedPanelists(ws, msg);
    if (!msg.panelists || !msg.panelists.length) {
      return { ok: false, error: "No panelists available." };
    }
    if (session._debate && debateFlow.isActiveDebatePhase(session._debate.phase) && session._debate.phase !== "reviewing") {
      return { ok: false, error: "A debate is already in progress." };
    }
    if (session._mentionInProgress) {
      return { ok: false, error: "A mention is in progress. Wait for it to finish." };
    }
    var userId = ws._clayUser ? ws._clayUser.id : null;
    var mateCtx = matesModule.buildMateCtx(userId);
    var resolved = debateFlow.resolveParticipants(
      msg.moderatorId,
      msg.panelists,
      function (mateId) { return resolveMateId(mateCtx, mateId); },
      function (mateId) { console.warn("[debate] Dropping unknown panelist mateId:", mateId); }
    );
    if (!resolved.ok) {
      return {
        ok: false,
        error: resolved.reason === "moderator"
          ? "Moderator does not match an existing Mate. Debate not started."
          : "None of the panelists match existing Mates. Debate not started.",
      };
    }
    return { ok: true, mateCtx: mateCtx, userId: userId, resolved: resolved };
  }

  function buildRestartDebate(msg, prepared) {
    var debate = debateState.createDebateState({
      phase: "reviewing",
      topic: msg.topic,
      format: msg.format || "free_discussion",
      context: msg.context || "",
      specialRequests: msg.specialRequests || null,
      moderatorId: prepared.resolved.moderatorId,
      panelists: prepared.resolved.panelists,
      mateCtx: prepared.mateCtx,
      nameMap: buildDebateNameMap(prepared.resolved.panelists, prepared.mateCtx),
      debateId: "debate_" + Date.now(),
      ownerId: prepared.userId,
    });
    return debate;
  }

  function buildPreparingDebate(msg, prepared) {
    return debateState.createDebateState({
      phase: "preparing",
      topic: msg.topic,
      format: "free_discussion",
      moderatorId: prepared.resolved.moderatorId,
      panelists: prepared.resolved.panelists,
      mateCtx: prepared.mateCtx,
      nameMap: buildDebateNameMap(prepared.resolved.panelists, prepared.mateCtx),
      ownerId: prepared.userId,
    });
  }

  function handleDebateStart(ws, msg) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var prepared = prepareDebateStart(ws, msg, session);
    if (!prepared.ok) {
      ctx.sendTo(ws, { type: "debate_error", error: prepared.error });
      return;
    }
    msg.moderatorId = prepared.resolved.moderatorId;
    msg.panelists = prepared.resolved.panelists;
    var moderatorProfile = ctx.getMateProfile(prepared.mateCtx, msg.moderatorId);

    // Restarting uses the persisted brief directly rather than sending the
    // user through setup again. The validation above intentionally also
    // applies here: a Mate removed since the previous debate must fail with
    // a clear error instead of creating a debate that cannot take a turn.
    if (msg.restartBrief) {
      var restartedDebate = buildRestartDebate(msg, prepared);
      session._debate = restartedDebate;
      console.log("[debate] Restarting with the persisted brief. Topic:", restartedDebate.topic);
      startDebateLive(session);
      return;
    }

    // --- Phase 1: Preparing (clay-debate-setup skill) ---
    var debate = buildPreparingDebate(msg, prepared);
    session._debate = debate;

    var debateId = "debate_" + Date.now();
    var debateDir = path.join(ctx.cwd, ".clay", "debates", debateId);
    try { fs.mkdirSync(debateDir, { recursive: true }); } catch (e) {}
    var briefPath = path.join(debateDir, "brief.json");
    console.log("[debate] cwd=" + ctx.cwd + " debateDir=" + debateDir + " briefPath=" + briefPath);

    debate.debateId = debateId;
    debate.briefPath = briefPath;

    if (msg.quickStart) {
      // --- Quick Start: moderator mate generates brief from DM context ---
      handleDebateQuickStart(ws, session, debate, msg, prepared.mateCtx, moderatorProfile, briefPath);
    } else {
      // --- Standard: clay-debate-setup skill ---
      handleDebateSkillSetup(ws, session, debate, msg, prepared.mateCtx, moderatorProfile, briefPath);
    }
  }

  // Quick start: moderator mate uses DM conversation context to generate the debate brief directly
  function handleDebateQuickStart(ws, session, debate, msg, mateCtx, moderatorProfile, briefPath) {
    debate.quickStart = true;
    var debateId = debate.debateId;

    // Create setup session (still needed for session grouping)
    var setupOpts = debate.ownerId ? { ownerId: debate.ownerId } : null;
    var setupSession = ctx.sm.createSession(setupOpts);
    setupSession.title = "Debate Setup: " + (msg.topic || "Quick").slice(0, 40);
    setupSession.debateSetupMode = true;
    setupSession.loop = { active: true, iteration: 0, role: "crafting", loopId: debateId, name: (msg.topic || "Quick").slice(0, 40), source: "debate", startedAt: Date.now() };
    ctx.sm.saveSessionFile(setupSession);
    ctx.sm.switchSession(setupSession.localId, null, ctx.hydrateImageRefs);
    debate.setupSessionId = setupSession.localId;
    debate.setupStartedAt = setupSession.loop.startedAt;
    // Share debate state with setup session so confirm_brief works from either
    setupSession._debate = debate;

    // Build DM conversation context for the moderator
    var dmContext = msg.dmContext || "";

    // Build panelist info
    var panelistInfo = msg.panelists.map(function (p) {
      var prof = ctx.getMateProfile(mateCtx, p.mateId);
      return "- " + (prof.name || p.mateId) + " (ID: " + p.mateId + ", bio: " + (prof.bio || "none") + ")";
    }).join("\n");

    var quickBriefPrompt = [
      "You are " + (moderatorProfile.name || "the moderator") + ". You were just having a DM conversation with the user, and they want to turn this into a structured debate.",
      "",
      "## Recent DM Conversation",
      dmContext,
      "",
      "## Topic Suggestion",
      msg.topic || "(Derive from conversation above)",
      "",
      "## Available Panelists",
      panelistInfo,
      "",
      "## Your Task",
      "Based on the conversation context, create a debate brief. You know the topic well because you were just discussing it.",
      msg.delegatePanelists
        ? "IMPORTANT: Select only 2-4 panelists who are most relevant to this specific topic. Do NOT include all of them. Be selective. Only pick mates whose expertise or personality directly contributes to this debate."
        : "The user already selected these panelists. Assign each one a role and perspective that will create the most productive debate.",
      "",
      "Output ONLY a valid JSON object (no markdown fences, no extra text):",
      "{",
      '  "topic": "refined debate topic",',
      '  "format": "free_discussion",',
      '  "context": "key context from DM conversation that panelists should know",',
      '  "specialRequests": "any special instructions (null if none)",',
      '  "panelists": [',
      '    { "mateId": "...", "role": "perspective/stance", "brief": "what this panelist should argue for" }',
      "  ]",
      "}",
    ].join("\n");

    // Persist and start watcher
    persistDebateState(session);
    startDebateBriefWatcher(session, debate, briefPath);

    // Notify clients
    var preparingMsg = {
      type: "debate_preparing",
      topic: debate.topic || "(Setting up...)",
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      setupSessionId: setupSession.localId,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name };
      }),
    };
    ctx.sendTo(ws, preparingMsg);
    ctx.sendToSession(session.localId, preparingMsg);
    ctx.sendToSession(setupSession.localId, preparingMsg);

    // Use moderator's own Claude identity to generate the brief via mention session
    var claudeMd = ctx.loadMateClaudeMd(mateCtx, debate.moderatorId);
    var digests = ctx.loadMateDigests(mateCtx, debate.moderatorId, debate.topic);

    var briefText = "";
    var _modMate = matesModule.getMate(mateCtx, debate.moderatorId);
    ctx.sdk.createMentionSession({
      vendor: _modMate ? _modMate.vendor : null,
      claudeMd: claudeMd,
      initialContext: digests,
      initialMessage: quickBriefPrompt,
      onActivity: function () {},
      onDelta: function (delta) { briefText += delta; },
      onDone: function () {
        try {
          var cleaned = briefText.trim();
          if (cleaned.indexOf("```") === 0) {
            cleaned = cleaned.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
          }
          // Validate it is parseable JSON
          JSON.parse(cleaned);
          // Write brief.json for the watcher to pick up
          fs.writeFileSync(briefPath, cleaned, "utf8");
          console.log("[debate-quick] Moderator generated brief, wrote to " + briefPath);
        } catch (e) {
          console.error("[debate-quick] Failed to generate brief:", e.message);
          console.error("[debate-quick] Raw output:", briefText.substring(0, 500));
          // Fall back: write a minimal brief
          var fallbackBrief = {
            topic: debate.topic || "Discussion",
            format: "free_discussion",
            context: "",
            specialRequests: null,
            panelists: debate.panelists.map(function (p) {
              var prof = ctx.getMateProfile(mateCtx, p.mateId);
              return { mateId: p.mateId, role: "participant", brief: "Share your perspective on the topic." };
            }),
          };
          try {
            fs.writeFileSync(briefPath, JSON.stringify(fallbackBrief), "utf8");
            console.log("[debate-quick] Wrote fallback brief");
          } catch (fe) {
            console.error("[debate-quick] Failed to write fallback brief:", fe.message);
            endDebate(session, "error");
          }
        }
      },
      onError: function (err) {
        console.error("[debate-quick] Moderator brief generation failed:", err);
        endDebate(session, "error");
      },
    });
  }

  // Standard debate setup via clay-debate-setup skill
  function handleDebateSkillSetup(ws, session, debate, msg, mateCtx, moderatorProfile, briefPath) {
    var debateId = debate.debateId;

    // Create a new session for the setup skill (like Ralph crafting)
    var skillSetupOpts = debate.ownerId ? { ownerId: debate.ownerId } : null;
    var setupSession = ctx.sm.createSession(skillSetupOpts);
    setupSession.title = "Debate Setup: " + msg.topic.slice(0, 40);
    setupSession.debateSetupMode = true;
    setupSession.loop = { active: true, iteration: 0, role: "crafting", loopId: debateId, name: msg.topic.slice(0, 40), source: "debate", startedAt: Date.now() };
    ctx.sm.saveSessionFile(setupSession);
    ctx.sm.switchSession(setupSession.localId, null, ctx.hydrateImageRefs);
    debate.setupSessionId = setupSession.localId;
    debate.setupStartedAt = setupSession.loop.startedAt;

    // Build panelist info for the skill prompt
    var panelistNames = msg.panelists.map(function (p) {
      var prof = ctx.getMateProfile(mateCtx, p.mateId);
      return prof.name || p.mateId;
    }).join(", ");

    var craftingPrompt = "Use the /clay-debate-setup skill to prepare a structured debate. " +
      "You MUST invoke the clay-debate-setup skill. Do NOT start the debate yourself.\n\n" +
      "## Initial Topic\n" + msg.topic + "\n\n" +
      "## Moderator\n" + (moderatorProfile.name || msg.moderatorId) + "\n\n" +
      "## Selected Panelists\n" + msg.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return "- " + (prof.name || p.mateId) + " (ID: " + p.mateId + ")";
      }).join("\n") + "\n\n" +
      "## Debate Brief Output Path\n" +
      "When the setup is complete, write the debate brief JSON to this EXACT absolute path:\n" +
      "`" + briefPath + "`\n" +
      "This is where the debate engine watches for the file. Do NOT write it anywhere else.\n\n" +
      "## Spoken Language\nKorean (unless user switches)";

    // Persist debate state before starting watcher
    persistDebateState(session);

    // Watch for brief.json in the debate-specific directory
    startDebateBriefWatcher(session, debate, briefPath);

    // Notify clients that setup is in progress
    var preparingMsg = {
      type: "debate_preparing",
      topic: debate.topic || "(Setting up...)",
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      setupSessionId: setupSession.localId,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name };
      }),
    };
    ctx.sendTo(ws, preparingMsg);
    ctx.sendToSession(session.localId, preparingMsg);

    // Start the setup skill session (don't send user_message to client — it's an internal prompt)
    setupSession.history.push({ type: "user_message", text: craftingPrompt, _internal: true });
    ctx.sm.appendToSessionFile(setupSession, { type: "user_message", text: craftingPrompt, _internal: true });
    setupSession.isProcessing = true;
    ctx.onProcessingChanged();
    setupSession.sentToolResults = {};
    ctx.sendToSession(setupSession.localId, { type: "status", status: "processing" });
    ctx.sdk.startQuery(setupSession, craftingPrompt, undefined, ctx.getLinuxUserForSession(setupSession));
  }

  // --- Mate strip processing indicator ---
  // Broadcast mention_processing so the correct mate's active dot lights up
  // on the mate strip during debate turns (instead of always the moderator's).
  function debateMateProcessing(mateId, active) {
    ctx.send({ type: "mention_processing", mateId: mateId, active: active });
  }

  // Persist a debate message to session history and send to clients
  function debateSendAndRecord(session, msg) {
    session.history.push(msg);
    ctx.sm.appendToSessionFile(session, msg);
    ctx.sendToSession(session.localId, msg);
  }

  // --- Live debate ---

  function startDebateLive(session) {
    var debate = session._debate;
    if (!debate || debate.phase === "live") return;

    debate.phase = "live";
    debate.turnInProgress = true;
    debate.round = 1;

    var mateCtx = debate.mateCtx;
    var moderatorProfile = ctx.getMateProfile(mateCtx, debate.moderatorId);

    // Create a dedicated debate session, grouped with the setup session
    var liveOpts = debate.ownerId ? { ownerId: debate.ownerId } : null;
    var debateSession = coopPlanning.record(session) ? session : ctx.sm.createSession(liveOpts);
    debateSession.title = debate.topic.slice(0, 50);
    debateSession.loop = { active: true, iteration: 1, role: "debate", loopId: debate.debateId, name: debate.topic.slice(0, 40), source: "debate", startedAt: debate.setupStartedAt || Date.now() };
    ctx.sm.saveSessionFile(debateSession);
    if (debateSession !== session) ctx.sm.switchSession(debateSession.localId, null, ctx.hydrateImageRefs);
    debate.liveSessionId = debateSession.localId;

    // Move _debate to the new session so all debate logic uses it
    debateSession._debate = debate;
    if (debateSession !== session) delete session._debate;
    // Clear persisted state from setup session, persist on live session
    session.debateState = null;
    ctx.sm.saveSessionFile(session);
    persistDebateState(debateSession);

    // Save to session history
    var debateStartEntry = {
      type: "debate_started",
      topic: debate.topic,
      format: debate.format,
      context: debate.context || "",
      specialRequests: debate.specialRequests || null,
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name, role: p.role || "", brief: p.brief || "", avatarColor: prof.avatarColor, avatarStyle: prof.avatarStyle, avatarSeed: prof.avatarSeed };
      }),
    };
    debateSession.history.push(debateStartEntry);
    ctx.sm.appendToSessionFile(debateSession, debateStartEntry);

    // Notify clients (same data as history entry)
    ctx.sendToSession(debateSession.localId, debateStartEntry);

    // Signal moderator's first turn
    debateMateProcessing(debate.moderatorId, true);
    debateSendAndRecord(debateSession, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    // Create moderator mention session
    var claudeMd = ctx.loadMateClaudeMd(mateCtx, debate.moderatorId);
    var digests = ctx.loadMateDigests(mateCtx, debate.moderatorId, debate.topic);
    var moderatorContext = buildModeratorContext(ctx, debate) + digests;

    var _modMate2 = matesModule.getMate(mateCtx, debate.moderatorId);
    ctx.sdk.createMentionSession({
      vendor: _modMate2 ? _modMate2.vendor : null,
      model: _modMate2 ? _modMate2.model : null,
      session: debateSession, readOnlyExecution: !!coopPlanning.record(debateSession),
      isCurrent: coopPlanning.currentGuard(debateSession),
      claudeMd: claudeMd,
      initialContext: moderatorContext,
      initialMessage: "Begin the debate on: " + debate.topic,
      onActivity: function (activity) {
        if (debateSession._debate && debateSession._debate.phase !== "ended") {
          ctx.sendToSession(debateSession.localId, { type: "debate_activity", mateId: debate.moderatorId, activity: activity });
        }
      },
      onDelta: function (delta) {
        if (debateSession._debate && debateSession._debate.phase !== "ended") {
          debateSendAndRecord(debateSession, { type: "debate_stream", mateId: debate.moderatorId, mateName: moderatorProfile.name, delta: delta });
        }
      },
      onDone: function (fullText) {
        handleModeratorTurnDone(debateSession, fullText);
      },
      onError: function (errMsg) {
        console.error("[debate] Moderator error:", errMsg);
        endDebate(debateSession, "error");
      },
      canUseTool: buildDebateToolHandler(debateSession),
    }).then(function (mentionSession) {
      if (mentionSession) {
        debate.moderatorSession = mentionSession;
      }
    }).catch(function (err) {
      console.error("[debate] Failed to create moderator session:", err.message || err);
      endDebate(debateSession, "error");
    });
  }

  // --- Turn management ---

  function handleModeratorTurnDone(session, fullText) {
    var debate = session._debate;
    if (!debate || debate.phase === "ended") return;

    debateMateProcessing(debate.moderatorId, false);
    debate.turnInProgress = false;

    // Record in debate history
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);
    debate.history.push({ speaker: "moderator", mateId: debate.moderatorId, mateName: moderatorProfile.name, text: fullText });

    // Save to session history
    var turnEntry = { type: "debate_turn_done", mateId: debate.moderatorId, mateName: moderatorProfile.name, role: "moderator", round: debate.round, text: fullText, avatarStyle: moderatorProfile.avatarStyle, avatarSeed: moderatorProfile.avatarSeed, avatarColor: moderatorProfile.avatarColor };
    session.history.push(turnEntry);
    ctx.sm.appendToSessionFile(session, turnEntry);
    ctx.sendToSession(session.localId, turnEntry);

    // Check if user stopped the debate during this turn
    if (debate.phase === "ending") {
      endDebate(session, "user_stopped");
      return;
    }

    // Detect @mentions
    console.log("[debate] nameMap keys:", JSON.stringify(Object.keys(debate.nameMap)));
    console.log("[debate] moderator text (last 200):", fullText.slice(-200));
    var mentionedIds = detectMentions(fullText, debate.nameMap);
    console.log("[debate] detected mentions:", JSON.stringify(mentionedIds));

    if (coopPlanning.record(session)) {
      if (debate.pendingComment) { injectUserComment(session); return; }
      if (debate.handRaised) { yieldFloorToUser(session); return; }
      if (session.history.slice(coopPlanning.record(session).revisionStartIndex || 0).filter(function (entry) {
        return entry.type === "debate_turn_done";
      }).length >= 24) { endDebate(session, "turn_limit"); return; }
      if (!mentionedIds.length) {
        var missing = coopPlanning.missingPanelist(session);
        if (missing) {
          advanceOrHold(session, function () { triggerPanelist(session, missing.mateId,
            "Give your independent assessment of the proposal and challenge unresolved assumptions."); });
        } else advanceOrHold(session, function () { startConclusionTurn(session); });
        return;
      }
    }

    if (mentionedIds.length === 0) {
      // No mentions = moderator wants to conclude. Ask user to confirm.
      console.log("[debate] No mentions detected, requesting user confirmation to end.");
      debate.turnInProgress = false;
      debate.awaitingConcludeConfirm = true;
      persistDebateState(session);
      var concludeEntry = { type: "debate_conclude_confirm", topic: debate.topic, round: debate.round };
      session.history.push(concludeEntry);
      ctx.sm.appendToSessionFile(session, concludeEntry);
      ctx.sendToSession(session.localId, concludeEntry);
      return;
    }

    // Check for pending user comment before triggering panelist
    if (debate.pendingComment) {
      injectUserComment(session);
      return;
    }

    // Check if user raised hand
    if (debate.handRaised) {
      yieldFloorToUser(session);
      return;
    }

    // Trigger the first mentioned panelist
    advanceOrHold(session, function () { triggerPanelist(session, mentionedIds[0], fullText); });
  }

  function findDebatePanelist(debate, mateId) {
    for (var i = 0; i < debate.panelists.length; i++) {
      if (debate.panelists[i].mateId === mateId) return debate.panelists[i];
    }
    return null;
  }

  function buildPanelistCallbacks(session, debate, mateId, profile) {
    return {
      onActivity: function (activity) {
        if (session._debate && session._debate.phase !== "ended") {
          ctx.sendToSession(session.localId, { type: "debate_activity", mateId: mateId, activity: activity });
        }
      },
      onDelta: function (delta) {
        if (session._debate && session._debate.phase !== "ended") {
          debate._currentTurnText += delta;
          debateSendAndRecord(session, { type: "debate_stream", mateId: mateId, mateName: profile.name, delta: delta });
        }
      },
      onDone: function (fullText) { handlePanelistTurnDone(session, mateId, fullText); },
      onError: function (errMsg) {
        console.error("[debate] Panelist error for " + mateId + ":", errMsg);
        debateMateProcessing(mateId, false);
        debate.turnInProgress = false;
        feedBackToModerator(session, mateId, "[" + profile.name + " encountered an error and could not respond. Please continue with other panelists or wrap up.]");
      },
    };
  }

  function continuePanelistTurn(session, debate, mateId, moderatorText, callbacks) {
    var existing = debate.panelistSessions[mateId];
    if (!existing || !existing.isAlive()) return false;
    existing.pushMessage(debateFlow.buildPanelistContinuation(debate.history, mateId, moderatorText), callbacks);
    return true;
  }

  function startPanelistSession(session, debate, mateId, moderatorText, panelistInfo, profile, callbacks) {
    var claudeMd = ctx.loadMateClaudeMd(debate.mateCtx, mateId);
    var digests = ctx.loadMateDigests(debate.mateCtx, mateId, debate.topic);
    var panelistContext = buildPanelistContext(ctx, debate, panelistInfo) + digests;
    var historyContext = debateFlow.buildDebateHistoryContext(debate.history);
    var panelMate = matesModule.getMate(debate.mateCtx, mateId);
    ctx.sdk.createMentionSession({
      vendor: panelMate ? panelMate.vendor : null,
      model: panelMate ? panelMate.model : null,
      session: session, readOnlyExecution: !!coopPlanning.record(session),
      isCurrent: coopPlanning.currentGuard(session),
      claudeMd: claudeMd,
      initialContext: panelistContext + historyContext,
      initialMessage: "The moderator addresses you:\n\n" + moderatorText,
      onActivity: callbacks.onActivity,
      onDelta: callbacks.onDelta,
      onDone: callbacks.onDone,
      onError: callbacks.onError,
      canUseTool: buildDebateToolHandler(session),
    }).then(function (mentionSession) {
      if (mentionSession) debate.panelistSessions[mateId] = mentionSession;
    }).catch(function (err) {
      console.error("[debate] Failed to create panelist session for " + mateId + ":", err.message || err);
      debateMateProcessing(mateId, false);
      debate.turnInProgress = false;
      feedBackToModerator(session, mateId, "[" + profile.name + " is unavailable. Please continue with other panelists or wrap up.]");
    });
  }

  function triggerPanelist(session, mateId, moderatorText) {
    var debate = session._debate;
    if (!debate || debate.phase === "ended") return;
    debate.turnInProgress = true;
    debate._currentTurnMateId = mateId;
    debate._currentTurnText = "";
    var profile = ctx.getMateProfile(debate.mateCtx, mateId);
    var panelistInfo = findDebatePanelist(debate, mateId);
    if (!panelistInfo) {
      console.error("[debate] Panelist not found:", mateId);
      debateMateProcessing(mateId, false);
      debate._currentTurnMateId = null;
      feedBackToModerator(session, mateId, "[This panelist is not part of the debate panel.]");
      return;
    }
    debateMateProcessing(mateId, true);
    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: mateId,
      mateName: profile.name,
      role: panelistInfo.role,
      round: debate.round,
      avatarColor: profile.avatarColor,
      avatarStyle: profile.avatarStyle,
      avatarSeed: profile.avatarSeed,
    });
    var callbacks = buildPanelistCallbacks(session, debate, mateId, profile);
    if (!continuePanelistTurn(session, debate, mateId, moderatorText, callbacks)) {
      startPanelistSession(session, debate, mateId, moderatorText, panelistInfo, profile, callbacks);
    }
  }

  function handlePanelistTurnDone(session, mateId, fullText) {
    var debate = session._debate;
    if (!debate || debate.phase === "ended") return;

    debateMateProcessing(mateId, false);
    debate.turnInProgress = false;
    debate._currentTurnMateId = null;
    debate._currentTurnText = "";

    var profile = ctx.getMateProfile(debate.mateCtx, mateId);
    var panelistInfo = null;
    for (var i = 0; i < debate.panelists.length; i++) {
      if (debate.panelists[i].mateId === mateId) {
        panelistInfo = debate.panelists[i];
        break;
      }
    }

    // Record in debate history
    debate.history.push({ speaker: "panelist", mateId: mateId, mateName: profile.name, role: panelistInfo ? panelistInfo.role : "", text: fullText });

    // Save to session history
    var turnEntry = { type: "debate_turn_done", mateId: mateId, mateName: profile.name, role: panelistInfo ? panelistInfo.role : "", round: debate.round, text: fullText, avatarStyle: profile.avatarStyle, avatarSeed: profile.avatarSeed, avatarColor: profile.avatarColor };
    session.history.push(turnEntry);
    ctx.sm.appendToSessionFile(session, turnEntry);
    ctx.sendToSession(session.localId, turnEntry);

    // Check if user stopped the debate
    if (debate.phase === "ending") {
      endDebate(session, "user_stopped");
      return;
    }

    // Check for pending user comment (legacy)
    if (debate.pendingComment) {
      injectUserComment(session);
      return;
    }

    // Check if user raised hand (no comment, just wants the floor)
    if (debate.handRaised) {
      yieldFloorToUser(session);
      return;
    }

    // Feed panelist response back to moderator
    advanceOrHold(session, function () { feedBackToModerator(session, mateId, fullText); });
  }

  // --- Pause (Debate Workflow v2) ---
  // Pause takes effect at turn boundaries only: the current speaker always
  // finishes, then the next trigger is held until the user resumes. User-
  // driven paths (hand raise, comments, conclude confirm) are never held —
  // pausing is about slowing the AI-to-AI chain, not locking the user out.
  function advanceOrHold(session, fn) {
    var debate = session._debate;
    if (debate && debate.paused) {
      try {
        require("./config").diagLog("[DEBATE-PAUSE] " + new Date().toISOString() +
          " holding at turn boundary, session=" + session.localId);
      } catch (e) {}
      debate._pendingAdvance = fn;
      ctx.sendToSession(session.localId, { type: "debate_pause_state", paused: true, holding: true });
      return;
    }
    fn();
  }

  function logDebatePauseToggle(ws, msg, session) {
    try {
      require("./config").diagLog("[DEBATE-PAUSE] " + new Date().toISOString() +
        " wsActive=" + JSON.stringify(ws && ws._clayActiveSession) +
        " (" + typeof (ws && ws._clayActiveSession) + ")" +
        " sessionFound=" + !!session +
        " hasDebate=" + !!(session && session._debate) +
        " phase=" + (session && session._debate ? session._debate.phase : "-") +
        " wantPaused=" + !!(msg && msg.paused));
    } catch (e) {}
  }

  // --- Structured conclusion (Debate Workflow v2) ---
  // A naturally-ended debate gets one final moderator turn producing a
  // fixed-format synthesis, persisted as a debate_conclusion entry — the
  // single canonical place to find what a debate decided. A user-stopped
  // debate skips this (nothing trustworthy to synthesize from an abort).
  function startConclusionTurn(session) {
    var debate = session._debate;
    if (!debate || debate.phase === "ended") return;
    if (!debate.moderatorSession) {
      // Rebuilt/degraded state (e.g. after a restart): no live moderator to
      // ask — end cleanly rather than hanging.
      endDebate(session, "natural");
      return;
    }

    debate.phase = "concluding";
    debate.paused = false;
    debate._pendingAdvance = null;
    debate.turnInProgress = true;
    persistDebateState(session);

    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);
    debateMateProcessing(debate.moderatorId, true);
    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    var prompt = "The debate is over. Write the final synthesis in plain language, " +
      "using EXACTLY this structure and nothing else:\n\n" +
      "RECOMMENDATION: <one short paragraph — the concrete answer to the topic>\n" +
      "KEY ARGUMENTS:\n- <bullet, attributed to the panelist who made it>\n" +
      "DISSENTS / TRADE-OFFS:\n- <bullet>\n" +
      "OPEN QUESTIONS:\n- <bullet>\n\n" +
      "Do not @mention anyone. Do not add closing pleasantries.";

    debate.moderatorSession.pushMessage(prompt, {
      onActivity: function () {},
      onDelta: function (delta) {
        if (session._debate && session._debate.phase !== "ended") {
          debateSendAndRecord(session, { type: "debate_stream", mateId: debate.moderatorId, mateName: moderatorProfile.name, delta: delta });
        }
      },
      onDone: function (fullText) {
        debateMateProcessing(debate.moderatorId, false);
        debate.turnInProgress = false;
        var conclusionEntry = {
          type: "debate_conclusion",
          topic: debate.topic,
          rounds: debate.round,
          text: fullText || "",
          moderatorName: moderatorProfile.name,
        };
        session.history.push(conclusionEntry);
        ctx.sm.appendToSessionFile(session, conclusionEntry);
        ctx.sendToSession(session.localId, conclusionEntry);
        endDebate(session, "natural");
      },
      onError: function (errMsg) {
        console.warn("[debate] Conclusion turn failed: " + errMsg + " — ending without synthesis.");
        debateMateProcessing(debate.moderatorId, false);
        endDebate(session, "natural");
      },
    });
  }

  function handleDebatePauseToggle(ws, msg) {
    var session = ctx.getSessionForWs(ws);
    logDebatePauseToggle(ws, msg, session);
    if (!session) {
      if (ws) ctx.sendTo(ws, { type: "debate_error", error: "Pause click could not be matched to a session — please report this." });
      return;
    }
    var debate = session._debate;
    if (!debate || debate.phase !== "live") {
      // Tell the client instead of silently ignoring the click (F-9).
      if (ws) ctx.sendTo(ws, { type: "debate_error", error: "No live debate is attached to this session — pause has no effect." });
      return;
    }
    var wantPaused = !!(msg && msg.paused);
    debate.paused = wantPaused;
    var transition = debateFlow.getPauseTransition(wantPaused, debate._pendingAdvance);
    if (transition.action === "resume") {
      var resumeFn = debate._pendingAdvance;
      debate._pendingAdvance = null;
      ctx.sendToSession(session.localId, { type: "debate_pause_state", paused: false, holding: false });
      resumeFn();
      return;
    }
    // Always acknowledge — even a no-op toggle — so the client's button
    // state converges on the server's truth instead of wedging.
    ctx.sendToSession(session.localId, { type: "debate_pause_state", paused: transition.paused, holding: transition.holding });
  }

  function feedBackToModerator(session, panelistMateId, panelistText) {
    var debate = session._debate;
    if (!debate || !debate.moderatorSession || debate.phase === "ended") return;

    debate.round++;
    debate.turnInProgress = true;

    var panelistProfile = ctx.getMateProfile(debate.mateCtx, panelistMateId);
    var panelistInfo = null;
    for (var i = 0; i < debate.panelists.length; i++) {
      if (debate.panelists[i].mateId === panelistMateId) {
        panelistInfo = debate.panelists[i];
        break;
      }
    }

    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);

    // Notify clients of moderator turn
    debateMateProcessing(debate.moderatorId, true);
    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    var feedText = "[Panelist Response]\n\n" +
      "@" + panelistProfile.name + " (" + (panelistInfo ? panelistInfo.role : "panelist") + ") responded:\n" +
      panelistText + "\n\n" +
      "Continue the debate. Call on the next panelist with @TheirName, or provide a closing summary (without any @mentions) to end the debate.";

    debate.moderatorSession.pushMessage(feedText, buildModeratorCallbacks(session));
  }

  function buildModeratorCallbacks(session) {
    var debate = session._debate;
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);
    return {
      onActivity: function (activity) {
        if (session._debate && session._debate.phase !== "ended") {
          ctx.sendToSession(session.localId, { type: "debate_activity", mateId: debate.moderatorId, activity: activity });
        }
      },
      onDelta: function (delta) {
        if (session._debate && session._debate.phase !== "ended") {
          debateSendAndRecord(session, { type: "debate_stream", mateId: debate.moderatorId, mateName: moderatorProfile.name, delta: delta });
        }
      },
      onDone: function (fullText) {
        handleModeratorTurnDone(session, fullText);
      },
      onError: function (errMsg) {
        console.error("[debate] Moderator error:", errMsg);
        endDebate(session, "error");
      },
    };
  }

  // --- User interaction during debate ---

  function handleDebateHandRaise(ws) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var debate = session._debate;
    if (!debate || debate.phase !== "live") return;
    if (debate.awaitingUserFloor || debate.handRaised) return;
    if (debate.awaitingConcludeConfirm) {
      ctx.sendTo(ws, { type: "debate_conclude_confirm", topic: debate.topic, round: debate.round });
      return;
    }

    debate.handRaised = true;
    ctx.sendToSession(session.localId, { type: "debate_hand_raised" });

    // If no one is speaking, yield floor immediately
    if (!debate.turnInProgress) {
      yieldFloorToUser(session);
    }
    // Otherwise: current speaker finishes -> handRaised detected -> yieldFloorToUser
  }

  function handleDebateComment(ws, msg) {
    // Legacy: kept for compatibility but now hand raise is separate
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var debate = session._debate;
    if (!debate || debate.phase !== "live") {
      ctx.sendTo(ws, { type: "debate_error", error: "No active debate." });
      return;
    }
    if (debate.awaitingUserFloor) return;
    if (!msg.text) return;

    debate.pendingComment = { text: msg.text };
    debate.handRaised = true;
    ctx.sendToSession(session.localId, { type: "debate_comment_queued", text: msg.text });

    if (!debate.turnInProgress) {
      injectUserComment(session);
    }
  }

  function yieldFloorToUser(session) {
    var debate = session._debate;
    if (!debate || !debate.moderatorSession || debate.phase === "ended") return;

    debate.handRaised = false;
    debate.turnInProgress = true;
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);

    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    var feedText = "[The user raised their hand to speak.]\n" +
      "[Acknowledge this briefly and yield the floor to the user. Say something like " +
      "\"Go ahead\" or \"The floor is yours\". Do NOT call on any panelist (no @mentions). " +
      "The debate will pause for the user to speak.]";

    debate.moderatorSession.pushMessage(feedText, buildModeratorYieldCallbacks(session));
  }

  function injectUserComment(session) {
    var debate = session._debate;
    if (!debate || !debate.pendingComment || !debate.moderatorSession || debate.phase === "ended") return;

    var comment = debate.pendingComment;
    debate.pendingComment = null;
    debate.handRaised = false;

    // Record in debate history
    debate.history.push({ speaker: "user", mateId: null, mateName: "User", text: comment.text });

    var commentEntry = { type: "debate_comment_injected", text: comment.text };
    session.history.push(commentEntry);
    ctx.sm.appendToSessionFile(session, commentEntry);
    ctx.sendToSession(session.localId, commentEntry);

    // Feed to moderator: yield the floor to the user
    debate.turnInProgress = true;
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);

    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    var feedText = "[The user raised their hand and said:]\n" +
      comment.text + "\n" +
      "[Acknowledge the user's input. Briefly respond, then YIELD THE FLOOR to the user by saying something like " +
      "\"The floor is yours\" or \"Go ahead\". Do NOT call on any panelist (no @mentions). " +
      "The debate will pause for the user to speak.]";

    debate.moderatorSession.pushMessage(feedText, buildModeratorYieldCallbacks(session));
  }

  function buildModeratorYieldCallbacks(session) {
    var debate = session._debate;
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);
    return {
      onActivity: function (activity) {
        if (session._debate && session._debate.phase !== "ended") {
          ctx.sendToSession(session.localId, { type: "debate_activity", mateId: debate.moderatorId, activity: activity });
        }
      },
      onDelta: function (delta) {
        if (session._debate && session._debate.phase !== "ended") {
          debateSendAndRecord(session, { type: "debate_stream", mateId: debate.moderatorId, mateName: moderatorProfile.name, delta: delta });
        }
      },
      onDone: function (fullText) {
        if (!debate || debate.phase === "ended") return;
        debate.turnInProgress = false;

        // Record moderator yield turn
        debate.history.push({ speaker: "moderator", mateId: debate.moderatorId, mateName: moderatorProfile.name, text: fullText });
        var turnEntry = { type: "debate_turn_done", mateId: debate.moderatorId, mateName: moderatorProfile.name, role: "moderator", round: debate.round, text: fullText, avatarStyle: moderatorProfile.avatarStyle, avatarSeed: moderatorProfile.avatarSeed, avatarColor: moderatorProfile.avatarColor };
        session.history.push(turnEntry);
        ctx.sm.appendToSessionFile(session, turnEntry);
        ctx.sendToSession(session.localId, turnEntry);

        // Enter user floor mode: pause debate and show input
        debate.awaitingUserFloor = true;
        persistDebateState(session);
        ctx.sendToSession(session.localId, { type: "debate_user_floor", topic: debate.topic, round: debate.round });
      },
      onError: function (errMsg) {
        console.error("[debate] Moderator yield error:", errMsg);
        endDebate(session, "error");
      },
    };
  }

  function handleDebateUserFloorResponse(ws, msg) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var debate = session._debate;
    if (!debate || !debate.awaitingUserFloor || debate.phase !== "live") return;

    debate.awaitingUserFloor = false;
    var userText = (msg && msg.text) ? msg.text.trim() : "";
    if (!userText) return;

    // Record user's floor contribution
    debate.history.push({ speaker: "user", mateId: null, mateName: "User", text: userText });
    var floorEntry = { type: "debate_user_floor_done", text: userText };
    session.history.push(floorEntry);
    ctx.sm.appendToSessionFile(session, floorEntry);
    ctx.sendToSession(session.localId, floorEntry);

    // Feed to moderator to resume debate
    debate.turnInProgress = true;
    var moderatorProfile = ctx.getMateProfile(debate.mateCtx, debate.moderatorId);

    debateMateProcessing(debate.moderatorId, true);
    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });

    var feedText = "[The user took the floor and said:]\n" +
      userText + "\n" +
      "[Acknowledge the user's contribution and resume the debate. Call on the next panelist with @TheirName.]";

    debate.moderatorSession.pushMessage(feedText, buildModeratorCallbacks(session));
    persistDebateState(session);
  }

  function handleDebateConfirmBrief(ws) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var debate = session._debate;
    if (!debate || debate.phase !== "reviewing") {
      ctx.sendTo(ws, { type: "debate_error", error: "No debate brief to confirm." });
      return;
    }

    console.log("[debate] User confirmed brief, transitioning to live. Topic:", debate.topic);
    startDebateLive(session);
  }

  function handleDebateStop(ws) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;

    var debate = session._debate;
    if (!debate) return;

    if (debate.phase === "reviewing") {
      endDebate(session, "user_stopped");
      return;
    }

    if (debate.phase !== "live") return;

    if (debate.turnInProgress) {
      // Let current turn finish, then end
      debate.phase = "ending";
    } else {
      endDebate(session, "user_stopped");
    }
  }

  // Rebuild _debate from session history (for resume after server restart)
  function buildRebuiltDebate(scan, session, ws) {
    var startEntry = scan.startEntry;
    var userId = ws._clayUser ? ws._clayUser.id : null;
    var mateCtx = matesModule.buildMateCtx(userId);
    var panelists = debateState.panelistsFromStart(startEntry.panelists || []);
    return debateState.createDebateState({
      phase: scan.endEntry ? "ended" : "live",
      topic: startEntry.topic || "",
      format: startEntry.format || "free_discussion",
      moderatorId: startEntry.moderatorId,
      panelists: panelists,
      mateCtx: mateCtx,
      nameMap: buildDebateNameMap(panelists, mateCtx),
      round: scan.lastRound,
      awaitingConcludeConfirm: !scan.endEntry && !!scan.concludeEntry,
      debateId: (session.loop && session.loop.loopId) || "debate_rebuilt",
    });
  }

  function rebuildDebateState(session, ws) {
    var scan = debateFlow.scanDebateHistory(session.history);
    if (!scan.startEntry) return null;
    var debate = buildRebuiltDebate(scan, session, ws);
    debate.history = debateFlow.toDebateHistory(scan.turns);
    if (!scan.endEntry && !scan.concludeEntry && debateFlow.inferRebuiltConcludeConfirm(debate, session.history, detectMentions)) {
      debate.awaitingConcludeConfirm = true;
      console.log("[debate] Last moderator turn had no mentions, setting awaitingConcludeConfirm.");
    }

    session._debate = debate;
    console.log("[debate] Rebuilt debate state from history. Topic:", debate.topic, "Phase:", debate.phase, "Turns:", debate.history.length);
    return debate;
  }

  function resumeDebateAfterConclude(session, debate, ws, msg, wasEnded) {
    if (!coopPlanning.resume(ctx, session)) {
      ctx.sendTo(ws, { type: "debate_error", error: "This planning revision could not be reopened. " +
        "A commissioned plan needs a new planning request; an unsaved revision must be retried." });
      return;
    }
    debate.phase = "live";
    var instruction = (msg.text || "").trim();
    var mateCtx = debate.mateCtx || matesModule.buildMateCtx(ws._clayUser ? ws._clayUser.id : null);
    debate.mateCtx = mateCtx;
    var moderatorProfile = ctx.getMateProfile(mateCtx, debate.moderatorId);
    if (instruction) {
      var resumeEntry = { type: "debate_user_resume", text: instruction };
      session.history.push(resumeEntry);
      ctx.sm.appendToSessionFile(session, resumeEntry);
      ctx.sendToSession(session.localId, resumeEntry);
    }
    var resumedMsg = {
      type: "debate_resumed",
      topic: debate.topic,
      round: debate.round,
      moderatorId: debate.moderatorId,
      moderatorName: moderatorProfile.name,
      panelists: debate.panelists.map(function (p) {
        var prof = ctx.getMateProfile(mateCtx, p.mateId);
        return { mateId: p.mateId, name: prof.name, role: p.role, avatarColor: prof.avatarColor, avatarStyle: prof.avatarStyle, avatarSeed: prof.avatarSeed };
      }),
    };
    session.history.push(resumedMsg);
    ctx.sm.appendToSessionFile(session, resumedMsg);
    ctx.sendToSession(session.localId, resumedMsg);
    debate.turnInProgress = true;
    debateMateProcessing(debate.moderatorId, true);
    debateSendAndRecord(session, {
      type: "debate_turn",
      mateId: debate.moderatorId,
      mateName: moderatorProfile.name,
      role: "moderator",
      round: debate.round,
      avatarColor: moderatorProfile.avatarColor,
      avatarStyle: moderatorProfile.avatarStyle,
      avatarSeed: moderatorProfile.avatarSeed,
    });
    var panelistNames = debate.panelists.map(function (p) {
      var prof = ctx.getMateProfile(mateCtx, p.mateId);
      return "@" + prof.name;
    });
    var resumePrompt = debateFlow.buildResumePrompt(instruction, panelistNames.join(", "));
    if (wasEnded || !debate.moderatorSession || !debate.moderatorSession.isAlive()) {
      startResumedModeratorSession(session, debate, mateCtx, moderatorProfile, resumePrompt);
      return;
    }
    debate.moderatorSession.pushMessage(resumePrompt, buildModeratorCallbacks(session));
  }

  function startResumedModeratorSession(session, debate, mateCtx, moderatorProfile, resumePrompt) {
    console.log("[debate] Creating new moderator session for resume");
    var claudeMd = ctx.loadMateClaudeMd(mateCtx, debate.moderatorId);
    var digests = ctx.loadMateDigests(mateCtx, debate.moderatorId, debate.topic);
    var moderatorContext = buildModeratorContext(ctx, debate) + digests + debateFlow.buildResumeHistoryContext(debate.history);
    var moderatorMate = matesModule.getMate(mateCtx, debate.moderatorId);
    ctx.sdk.createMentionSession({
      vendor: moderatorMate ? moderatorMate.vendor : null,
      model: moderatorMate ? moderatorMate.model : null,
      session: session, readOnlyExecution: !!coopPlanning.record(session),
      isCurrent: coopPlanning.currentGuard(session),
      claudeMd: claudeMd,
      initialContext: moderatorContext,
      initialMessage: resumePrompt,
      onActivity: function (activity) {
        if (session._debate && session._debate.phase !== "ended") {
          ctx.sendToSession(session.localId, { type: "debate_activity", mateId: debate.moderatorId, activity: activity });
        }
      },
      onDelta: function (delta) {
        if (session._debate && session._debate.phase !== "ended") {
          debateSendAndRecord(session, { type: "debate_stream", mateId: debate.moderatorId, mateName: moderatorProfile.name, delta: delta });
        }
      },
      onDone: function (fullText) { handleModeratorTurnDone(session, fullText); },
      onError: function (errMsg) {
        console.error("[debate] Moderator resume error:", errMsg);
        endDebate(session, "error");
      },
      canUseTool: buildDebateToolHandler(session),
    }).then(function (mentionSession) {
      if (mentionSession) debate.moderatorSession = mentionSession;
    }).catch(function (err) {
      console.error("[debate] Failed to create resume moderator session:", err.message || err);
      endDebate(session, "error");
    });
  }

  function handleDebateConcludeResponse(ws, msg) {
    var session = ctx.getSessionForWs(ws);
    if (!session) return;
    var debate = session._debate;
    if (!debate) {
      debate = rebuildDebateState(session, ws);
      if (!debate) {
        console.log("[debate] Cannot rebuild debate state for resume.");
        return;
      }
    }
    var response = debateFlow.getConcludeResponse(debate, msg);
    if (!response.ok) return;
    debate.awaitingConcludeConfirm = false;
    if (response.action === "end") {
      startConclusionTurn(session);
      return;
    }
    if (response.action !== "continue") return;
    resumeDebateAfterConclude(session, debate, ws, msg, response.wasEnded);
  }

  // --- End debate ---

  function endDebate(session, reason) {
    var debate = session._debate;
    if (!debate || debate.phase === "ended") return;

    // Clear all mate strip processing dots
    debateMateProcessing(debate.moderatorId, false);
    for (var ei = 0; ei < debate.panelists.length; ei++) {
      debateMateProcessing(debate.panelists[ei].mateId, false);
    }

    debate.phase = "ended";
    debate.turnInProgress = false;
    persistDebateState(session);

    // Clean up brief watcher if still active
    if (debate._briefWatcher) {
      try { debate._briefWatcher.close(); } catch (e) {}
      debate._briefWatcher = null;
    }

    // Notify clients
    var endedBrief = {
      topic: debate.topic,
      format: debate.format || "free_discussion",
      context: debate.context || "",
      specialRequests: debate.specialRequests || null,
      moderatorId: debate.moderatorId,
      panelists: debate.panelists.map(function (p) {
        return { mateId: p.mateId, role: p.role || "", brief: p.brief || "" };
      }),
    };
    ctx.sendToSession(session.localId, Object.assign({
      type: "debate_ended",
      reason: reason,
      rounds: debate.round,
    }, endedBrief));

    // Save to session history
    var endEntry = Object.assign({ type: "debate_ended", rounds: debate.round, reason: reason }, endedBrief);
    session.history.push(endEntry);
    ctx.sm.appendToSessionFile(session, endEntry);

    if (coopPlanning.finish(ctx, session, reason)) return;

    // Generate digests for all participants
    digestDebateParticipant(session, debate.moderatorId, debate, "moderator");
    for (var i = 0; i < debate.panelists.length; i++) {
      digestDebateParticipant(session, debate.panelists[i].mateId, debate, debate.panelists[i].role);
    }
  }

  function digestDebateParticipant(session, mateId, debate, role) {
    var mentionSession = null;
    if (mateId === debate.moderatorId) {
      mentionSession = debate.moderatorSession;
    } else {
      mentionSession = debate.panelistSessions[mateId];
    }
    if (!mentionSession || !mentionSession.isAlive()) return;

    var mateDir = matesModule.getMateDir(debate.mateCtx, mateId);
    var knowledgeDir = path.join(mateDir, "knowledge");

    // Migration: generate initial summary if missing
    var summaryFile = path.join(knowledgeDir, "memory-summary.md");
    var digestFileCheck = path.join(knowledgeDir, "session-digests.jsonl");
    if (!fs.existsSync(summaryFile) && fs.existsSync(digestFileCheck)) {
      ctx.initMemorySummary(debate.mateCtx, mateId, function () {});
    }

    // Debates are user-initiated structured events. The moderator already
    // synthesizes a summary, so skip the memory gate and always create a digest.
    (function () {
      var digestPrompt = [
        "[SYSTEM: Session Digest]",
        "Summarize this conversation from YOUR perspective for your long-term memory.",
        "Output ONLY a single valid JSON object (no markdown, no code fences, no extra text).",
        "",
        "Schema:",
        "{",
        '  "date": "YYYY-MM-DD",',
        '  "type": "debate",',
        '  "topic": "short topic description",',
        '  "my_position": "what I said/recommended",',
        '  "decisions": "what was decided, or null if pending",',
        '  "open_items": "what remains unresolved",',
        '  "user_sentiment": "how the user seemed to feel",',
        '  "my_role": "' + role + '",',
        '  "other_perspectives": "key points from others",',
        '  "outcome": "how the debate concluded",',
        '  "confidence": "high | medium | low",',
        '  "revisit_later": true/false,',
        '  "tags": ["relevant", "topic", "tags"]',
        "}",
        "",
        "IMPORTANT: Output ONLY the JSON object. Nothing else.",
      ].join("\n");

      var digestText = "";
      mentionSession.pushMessage(digestPrompt, {
        onActivity: function () {},
        onDelta: function (delta) {
          digestText += delta;
        },
        onDone: function () {
          var digestObj = null;
          try {
            var cleaned = digestText.trim();
            if (cleaned.indexOf("```") === 0) {
              cleaned = cleaned.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
            }
            digestObj = JSON.parse(cleaned);
          } catch (e) {
            console.error("[debate-digest] Failed to parse digest JSON for mate " + mateId + ":", e.message);
            digestObj = {
              date: new Date().toISOString().slice(0, 10),
              type: "debate",
              topic: debate.topic,
              my_role: role,
              raw: digestText.substring(0, 500),
            };
          }

          try {
            fs.mkdirSync(knowledgeDir, { recursive: true });
            var digestFile = path.join(knowledgeDir, "session-digests.jsonl");
            fs.appendFileSync(digestFile, JSON.stringify(digestObj) + "\n");
          } catch (e) {
            console.error("[debate-digest] Failed to write digest for mate " + mateId + ":", e.message);
          }

          // Update memory summary
          ctx.updateMemorySummary(debate.mateCtx, mateId, digestObj);

          // Close the session after digest
          mentionSession.close();
        },
        onError: function (err) {
          console.error("[debate-digest] Digest generation failed for mate " + mateId + ":", err);
          mentionSession.close();
        },
      });
    })();
  }

  // --- MCP-based debate proposal approval ---

  // Returns { ok: true } when the debate actually started, else
  // { ok: false, reason } — the router forwards that outcome to the MCP
  // proposal promise so the proposing model is never told "started" when
  // nothing started (F-6 in the Phase 0 audit: approval used to resolve
  // "start" unconditionally while every bail path below no-oped silently).
  function sendMcpApprovalError(ws, error) {
    if (ws) ctx.sendTo(ws, { type: "debate_error", error: error });
  }

  function prepareMcpDebateApproval(session, briefData, mateId, ws) {
    var userId = ws && ws._clayUser ? ws._clayUser.id : (session.ownerId || ctx.projectOwnerId || null);
    var mateCtx = matesModule.buildMateCtx(userId);
    var panelists = debateFlow.normalizePanelists(
      briefData.panelists,
      function (panelistId) { return resolveMateId(mateCtx, panelistId); },
      function (panelistId) { console.warn("[debate] Dropping unknown panelist mateId:", panelistId); }
    );
    if (!panelists.length) {
      return { ok: false, reason: "no proposed panelist matches an existing Mate", error: "None of the proposed panelists match existing Mates. Debate not started." };
    }
    var moderatorId = resolveMateId(mateCtx, mateId);
    if (!moderatorId) {
      moderatorId = pickFallbackModerator(mateCtx, panelists.map(function (p) { return p.mateId; }));
      if (moderatorId) console.log("[debate] No moderator mate on proposal; falling back to", moderatorId);
    }
    if (!moderatorId) {
      return { ok: false, reason: "no available Mate can moderate", error: "No available Mate can moderate this debate. Debate not started." };
    }
    return { ok: true, userId: userId, mateCtx: mateCtx, moderatorId: moderatorId, panelists: panelists, debateId: "debate_" + Date.now() };
  }

  function buildMcpDebateState(briefData, prepared) {
    return debateState.createDebateState({
      phase: "reviewing",
      topic: briefData.topic || "Untitled debate",
      format: briefData.format || "free_discussion",
      context: briefData.context || "",
      specialRequests: briefData.specialRequests || null,
      moderatorId: prepared.moderatorId,
      panelists: prepared.panelists,
      mateCtx: prepared.mateCtx,
      debateId: prepared.debateId,
      ownerId: prepared.userId,
    });
  }

  function handleMcpDebateApproval(session, briefData, mateId, ws) {
    if (!session) {
      console.warn("[debate] Cannot start MCP debate: approval ws has no active session");
      sendMcpApprovalError(ws, "Could not match this approval to an active session. Open the session that proposed the debate and approve again.");
      return { ok: false, reason: "the approving client has no active session" };
    }
    if (session._debate && debateFlow.isActiveDebatePhase(session._debate.phase)) {
      console.warn("[debate] Cannot start MCP debate: another debate is active on this session");
      sendMcpApprovalError(ws, "Another debate is already active on this session. Stop it before starting a new one.");
      return { ok: false, reason: "another debate is already active on this session" };
    }
    var prepared = prepareMcpDebateApproval(session, briefData, mateId, ws);
    if (!prepared.ok) {
      console.warn("[debate] Cannot start MCP debate:", prepared.reason);
      sendMcpApprovalError(ws, prepared.error);
      return { ok: false, reason: prepared.reason };
    }
    var debate = buildMcpDebateState(briefData, prepared);
    debate.nameMap = buildDebateNameMap(debate.panelists, prepared.mateCtx);
    session._debate = debate;

    console.log("[debate] MCP debate approved. Topic:", debate.topic, "debateId:", prepared.debateId);
    startDebateLive(session);
    return { ok: true };
  }

  // --- Public API ---

  return {
    handleDebateStart: handleDebateStart,
    handleDebateHandRaise: handleDebateHandRaise,
    handleDebateComment: handleDebateComment,
    handleDebateStop: handleDebateStop,
    handleDebateConcludeResponse: handleDebateConcludeResponse,
    handleDebateConfirmBrief: handleDebateConfirmBrief,
    handleDebateUserFloorResponse: handleDebateUserFloorResponse,
    restoreDebateState: restoreDebateState,
    checkForDmDebateBrief: checkForDmDebateBrief,
    handleMcpDebateApproval: handleMcpDebateApproval,
    handleDebatePauseToggle: handleDebatePauseToggle,
  };
}

module.exports = { attachDebate: attachDebate };
