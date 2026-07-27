var crypto = require("crypto");
var taskGraph = require("./orchestration-task-graph");
var sanitizeDiagnosticsPacket =
  require("./project-live-ui-context").sanitizeDiagnosticsPacket;

var MAX_SCREENSHOT_BASE64 = 10 * 1024 * 1024;
var PNG_SIGNATURE = "89504e470d0a1a0a";

function screenshotFromPayload(payload) {
  var screenshot = payload && payload.screenshot;
  var data = screenshot && typeof screenshot.data === "string" ? screenshot.data : "";
  var validBase64 = data.length > 0 &&
    data.length <= MAX_SCREENSHOT_BASE64 &&
    data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  var decoded = validBase64 ? Buffer.from(data, "base64") : null;
  if (!screenshot || screenshot.mediaType !== "image/png" || !decoded ||
      decoded.length < 8 ||
      decoded.subarray(0, 8).toString("hex") !== PNG_SIGNATURE) {
    var error = new Error("Every Live UI report requires a bounded masked PNG screenshot");
    error.code = "LIVE_UI_SCREENSHOT_REQUIRED";
    throw error;
  }
  return { mediaType: "image/png", data: data };
}

function reportTitle(text) {
  var firstLine = String(text || "").split(/\r?\n/)[0]
    .replace(/\s+/g, " ").trim();
  return (firstLine || "Live UI report").slice(0, 90);
}

function selectionContext(selection) {
  if (!selection) return "No element was selected. Treat this as a page-wide report.";
  return [
    "Selected target:",
    "- Route: " + (selection.route || "/"),
    "- Element: " + (selection.tag || "unknown"),
    "- Accessible name: " + (selection.accessibleName || "none"),
    "- Visible text: " + (selection.text || "none"),
    "- Selector candidates: " + (selection.selectors || []).join(", "),
    "- Fingerprint: " + (selection.fingerprint || "none"),
    "Selectors are candidates. Inspect source ownership before editing.",
  ].join("\n");
}

function diagnosticsContext(diagnostics) {
  var lines = ["Automatic evidence captured when the report was submitted:"];
  var consoleEntries = diagnostics.console || [];
  var networkEntries = diagnostics.network || [];
  lines.push("- Masked viewport screenshot: attached.");
  lines.push("- Recent console entries: " + consoleEntries.length + ".");
  for (var i = 0; i < consoleEntries.length; i++) {
    lines.push("  [" + consoleEntries[i].level + "] " + consoleEntries[i].text);
  }
  lines.push("- Recent network entries: " + networkEntries.length + ".");
  for (var j = 0; j < networkEntries.length; j++) {
    var request = networkEntries[j];
    lines.push("  " + request.method + " " + request.url + " -> " +
      (request.status === null ? "unknown" : request.status) +
      (request.error ? " (" + request.error + ")" : ""));
  }
  return lines.join("\n");
}

function publicRecord(record) {
  return {
    reportId: record.reportId,
    title: record.title,
    status: record.status,
    message: record.message,
  };
}

function taskPresentation(task) {
  if (!task) return { status: "failed", message: "The worker task is unavailable." };
  if (task.status === "failed" || task.status === "cancelled") {
    return { status: "failed", message: "The issue could not be completed." };
  }
  if (task.status === "needs_input" || task.status === "blocked") {
    return { status: "needs_input", message: "Input is needed in Clay." };
  }
  if (task.status === "completed" && task.resolvedByCoordinator) {
    return { status: "completed", message: "Completed and verified." };
  }
  if (task.status === "completed") {
    return { status: "working", message: "The coordinator is reviewing the result." };
  }
  return { status: "working", message: "Being worked on." };
}

function attachLiveUiReports(ctx) {
  var pairSessions = new Map();
  var pairReports = new Map();
  var pollTimer = null;

  function recordsFor(pairingId) {
    if (!pairReports.has(pairingId)) pairReports.set(pairingId, new Map());
    return pairReports.get(pairingId);
  }

  function sendReport(pairing, event, record) {
    ctx.sendTarget(pairing, event, publicRecord(record));
  }

  function checkReports() {
    var hasActive = false;
    pairReports.forEach(function (records, pairingId) {
      var pairing = null;
      try {
        pairing = ctx.registry.getPair(pairingId);
      } catch (e) {
        return;
      }
      records.forEach(function (record) {
        if (record.status === "completed" || record.autoClosed) return;
        hasActive = true;
        var session = pairSessions.get(pairingId);
        var task = session ? taskGraph.findTask(session, record.taskId) : null;
        var presentation = taskPresentation(task);
        if (presentation.status !== record.status ||
            presentation.message !== record.message) {
          record.status = presentation.status;
          record.message = presentation.message;
          sendReport(pairing, "report.status", record);
        }
        if (presentation.status === "completed" && !record.autoClosed) {
          record.autoClosed = true;
          ctx.closeTask(pairing, session, record.taskId);
        }
      });
    });
    if (!hasActive && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(checkReports, 700);
    if (pollTimer.unref) pollTimer.unref();
  }

  function registerPair(pairingId, sessionId) {
    pairSessions.set(pairingId, sessionId);
    recordsFor(pairingId);
  }

  function clearPair(pairingId) {
    pairSessions.delete(pairingId);
    pairReports.delete(pairingId);
  }

  function sendSnapshot(pairing) {
    var records = Array.from(recordsFor(pairing.pairingId).values())
      .map(publicRecord);
    ctx.sendTarget(pairing, "reports.snapshot", { reports: records });
  }

  function handleMessage(ws, msg, pairing, selection) {
    ctx.assertExtensionSender(ws, pairing);
    var text = msg.payload && typeof msg.payload.text === "string"
      ? msg.payload.text.trim().slice(0, 12000)
      : "";
    if (!text) {
      var emptyError = new Error("Describe the issue before reporting it");
      emptyError.code = "LIVE_UI_REPORT_EMPTY";
      throw emptyError;
    }
    var screenshot = screenshotFromPayload(msg.payload);
    var sanitizedDiagnostics = sanitizeDiagnosticsPacket(
      msg.payload && msg.payload.diagnostics);
    if (!sanitizedDiagnostics.ok) {
      var diagnosticsError = new Error(sanitizedDiagnostics.error);
      diagnosticsError.code = "LIVE_UI_DIAGNOSTICS_INVALID";
      throw diagnosticsError;
    }
    var session = pairSessions.get(pairing.pairingId);
    if (!session) {
      var sessionError = new Error("The pinned Clay session is no longer available");
      sessionError.code = "LIVE_UI_SESSION_GONE";
      throw sessionError;
    }
    var reportId = crypto.randomUUID();
    var title = reportTitle(text);
    var accepted = ctx.registry.acceptMessage(
      pairing.pairingId,
      msg.clientMessageId,
      function () {
        var owner = ctx.getLinuxUserForSession ?
          ctx.getLinuxUserForSession(session) : null;
        var imageFile = ctx.saveImageFile(
          screenshot.mediaType, screenshot.data, owner);
        if (!imageFile) {
          var imageError = new Error("Clay could not store the report screenshot");
          imageError.code = "LIVE_UI_SCREENSHOT_STORE_FAILED";
          throw imageError;
        }
        var result = ctx.coordinateExternalTask({
          coordinatorSessionId: session.storageId || session.localId,
          promoteCoordinator: true,
          title: title,
          objective: text,
          context: [
            "This issue came from the paired Live UI target.",
            selectionContext(selection),
            diagnosticsContext(sanitizedDiagnostics.packet),
          ].join("\n\n"),
          acceptanceCriteria: [
            "Implement the requested source-backed fix.",
            "Verify the relevant behavior and repository checks.",
            "Do not claim completion until concrete verification is available.",
          ].join(" "),
          ownedPaths: "Live UI report " + reportId +
            ". Infer the smallest safe source boundary and report overlap with another worker.",
          clientRef: "live-ui:" + pairing.pairingId + ":" + msg.clientMessageId,
          imageRefs: [{ mediaType: screenshot.mediaType, file: imageFile }],
        });
        if (!result || !result.ok) {
          var taskError = new Error(result && result.error ?
            result.error : "Clay could not create the worker task");
          taskError.code = "LIVE_UI_REPORT_DISPATCH_FAILED";
          throw taskError;
        }
        var record = {
          reportId: reportId,
          taskId: result.orchestrationTaskId,
          title: title,
          status: "working",
          message: "Being worked on.",
          autoClosed: false,
        };
        recordsFor(pairing.pairingId).set(reportId, record);
        return {
          accepted: true,
          reportId: reportId,
          taskId: result.orchestrationTaskId,
          title: title,
        };
      }
    );
    var acknowledgment = accepted.acknowledgment;
    var record = recordsFor(pairing.pairingId).get(acknowledgment.reportId);
    if (record) sendReport(pairing, "report.accepted", record);
    ensurePolling();
  }

  return {
    clearPair: clearPair,
    handleMessage: handleMessage,
    registerPair: registerPair,
    sendSnapshot: sendSnapshot,
  };
}

module.exports = {
  attachLiveUiReports: attachLiveUiReports,
};
