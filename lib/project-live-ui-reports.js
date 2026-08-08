var crypto = require("crypto");
var taskGraph = require("./orchestration-task-graph");
var sanitizeDiagnosticsPacket =
  require("./project-live-ui-context").sanitizeDiagnosticsPacket;
var liveUiAttachments = require("./project-live-ui-attachments");
var attachLiveUiReportStore =
  require("./project-live-ui-report-store").attachLiveUiReportStore;

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

function workerLabel(record) {
  if (!record.workerSessionId) return "Queued worker";
  return "Worker " + String(record.workerSessionId).slice(0, 8);
}

function selectionContext(selection) {
  if (!selection) return "No element was selected. Treat this as a page-wide report.";
  var lines = [
    "Selected target:",
    "- Route: " + (selection.route || "/"),
    "- Element: " + (selection.tag || "unknown"),
    "- Accessible name: " + (selection.accessibleName || "none"),
    "- Visible text: " + (selection.text || "none"),
    "- Selector candidates: " + (selection.selectors || []).join(", "),
    "- Fingerprint: " + (selection.fingerprint || "none"),
  ];
  if (selection.component) {
    lines.push("- React component: " + selection.component.name);
    lines.push("- Component chain: " + selection.component.chain.join(" > "));
    var source = selection.component.source;
    lines.push("- Likely source: " + (source ?
      source.file + (source.line ? ":" + source.line : "") :
      "unavailable from the development transform"));
  }
  lines.push("Selectors and source locations are candidates. Confirm ownership before editing.");
  return lines.join("\n");
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

function workspaceContext(pairing) {
  return [
    "Live UI source workspace:",
    "- Writable root: " + pairing.writableRoot,
    "- Inspect and edit source only inside this root unless the owner explicitly changes scope.",
    "- The browser target was server-verified against this workspace before pairing.",
  ].join("\n");
}

function reportImageRefs(input) {
  return [{ mediaType: input.screenshot.mediaType, file: input.imageFile }]
    .concat(input.attachmentImageRefs || []);
}

function publicRecord(record) {
  return {
    reportId: record.reportId,
    title: record.title,
    status: record.status,
    message: record.message,
    worker: {
      sessionId: record.workerSessionId || null,
      label: workerLabel(record),
      color: record.workerColor,
    },
    locator: record.selection ? {
      route: record.selection.route,
      selectors: record.selection.selectors,
      component: record.selection.component || null,
    } : null,
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
    return { status: "completed", message: "Ready for your review." };
  }
  if (task.status === "completed") {
    return { status: "working", message: "The coordinator is reviewing the result." };
  }
  return { status: "working", message: "Being worked on." };
}

function attachLiveUiReports(ctx) {
  var pairSessions = new Map();
  var reportStore = attachLiveUiReportStore({
    persistSession: ctx.persistSession,
    presentTask: taskPresentation,
  });
  var pollTimer = null;

  function recordsFor(pairingId) {
    var session = pairSessions.get(pairingId);
    return session ? reportStore.recordsFor(session) : new Map();
  }

  function sendReport(pairing, event, record) {
    ctx.sendTarget(pairing, event, publicRecord(record));
  }

  function refreshRecord(session, record) {
    var task = session ? taskGraph.findTask(session, record.taskId) : null;
    var presentation = taskPresentation(task);
    var workerSessionId = task && task.workerSessionId || null;
    var workerColor = task && task.workerColor || record.workerColor;
    var changed = record.status !== presentation.status ||
      record.message !== presentation.message ||
      record.workerSessionId !== workerSessionId ||
      record.workerColor !== workerColor;
    record.status = presentation.status;
    record.message = presentation.message;
    record.workerSessionId = workerSessionId;
    record.workerColor = workerColor;
    return changed;
  }

  function taskIsClosed(session, record) {
    var task = session ? taskGraph.findTask(session, record.taskId) : null;
    return !!(task && (task.status === "dismissed" || task.status === "cancelled"));
  }

  function checkReports() {
    var hasActive = false;
    pairSessions.forEach(function (session, pairingId) {
      var pairing = null;
      try {
        pairing = ctx.registry.getPair(pairingId);
      } catch (e) {
        return;
      }
      var changed = false;
      recordsFor(pairingId).forEach(function (record) {
        if (record.dismissed) return;
        if (taskIsClosed(session, record)) {
          record.dismissed = true;
          changed = true;
          ctx.sendTarget(pairing, "report.removed", { reportId: record.reportId });
          return;
        }
        if (record.status === "completed" || record.status === "failed") return;
        hasActive = true;
        if (refreshRecord(session, record)) {
          changed = true;
          sendReport(pairing, "report.status", record);
        }
      });
      if (changed) reportStore.persist(session, recordsFor(pairingId));
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

  function registerPair(pairingId, session) {
    pairSessions.set(pairingId, session);
    recordsFor(pairingId);
  }

  function clearPair(pairingId) {
    pairSessions.delete(pairingId);
  }

  function sendSnapshot(pairing) {
    var session = pairSessions.get(pairing.pairingId);
    var recordsMap = recordsFor(pairing.pairingId);
    var changed = false;
    var hasActive = false;
    recordsMap.forEach(function (record) {
      if (record.dismissed) return;
      if (taskIsClosed(session, record)) {
        record.dismissed = true;
        changed = true;
        return;
      }
      if (refreshRecord(session, record)) changed = true;
      if (record.status !== "completed" && record.status !== "failed") hasActive = true;
    });
    if (changed && session) reportStore.persist(session, recordsMap);
    if (hasActive) ensurePolling();
    var records = Array.from(recordsMap.values())
      .filter(function (record) { return !record.dismissed; })
      .map(publicRecord);
    ctx.sendTarget(pairing, "reports.snapshot", { reports: records });
  }

  function storeScreenshot(session, screenshot) {
    var owner = ctx.getLinuxUserForSession ?
      ctx.getLinuxUserForSession(session) : null;
    var imageFile = ctx.saveImageFile(screenshot.mediaType, screenshot.data, owner);
    if (imageFile) return imageFile;
    var error = new Error("Clay could not store the report screenshot");
    error.code = "LIVE_UI_SCREENSHOT_STORE_FAILED";
    throw error;
  }

  function continueReport(input) {
    var existing = input.existing;
    var result = ctx.followUpTask({
      coordinatorSessionId: input.session.storageId || input.session.localId,
      taskId: existing.taskId,
      message: [
        "Live UI follow-up for the existing issue:",
        input.text,
        "",
        selectionContext(input.selection || existing.selection),
        "",
        diagnosticsContext(input.diagnostics),
        "",
        workspaceContext(input.pairing),
        "",
        liveUiAttachments.attachmentContext(input.attachments),
        "",
        "Continue in this same worker conversation. Recheck the updated request and " +
          "do not treat the earlier completion as approval.",
      ].join("\n"),
      imageRefs: reportImageRefs(input),
      _liveUiFollowup: true,
    });
    if (!result || result.isError) {
      var content = result && Array.isArray(result.content) ? result.content : [];
      var error = new Error(content[0] && content[0].text ?
        content[0].text : "Clay could not continue the selected worker");
      error.code = "LIVE_UI_REPORT_FOLLOWUP_FAILED";
      throw error;
    }
    existing.status = "working";
    existing.message = "Follow-up sent to " + workerLabel(existing) + ".";
    existing.selection = input.selection || existing.selection;
    reportStore.persist(input.session, recordsFor(input.pairing.pairingId));
    return {
      accepted: true,
      reportId: existing.reportId,
      taskId: existing.taskId,
      title: existing.title,
    };
  }

  function createReport(input) {
    var result = ctx.coordinateExternalTask({
      coordinatorSessionId: input.session.storageId || input.session.localId,
      promoteCoordinator: true,
      title: input.title,
      objective: input.text,
      context: [
        "This issue came from the paired Live UI target.",
        selectionContext(input.selection),
        diagnosticsContext(input.diagnostics),
        workspaceContext(input.pairing),
        liveUiAttachments.attachmentContext(input.attachments),
      ].join("\n\n"),
      acceptanceCriteria: [
        "Implement the requested source-backed fix.",
        "For React client edits, preserve the existing Fast Refresh boundary and avoid a full page reload.",
        "Verify the relevant behavior and repository checks.",
        "Do not claim completion until concrete verification is available.",
      ].join(" "),
      ownedPaths: "Live UI report " + input.reportId +
        ". Writable root: " + input.pairing.writableRoot +
        (input.selection && input.selection.component && input.selection.component.source ?
          ". Likely component source: " + input.selection.component.source.file + "." :
          ".") +
        " Confirm the smallest safe source boundary and report overlap with another worker.",
      clientRef: "live-ui-report:" + input.reportId,
      imageRefs: reportImageRefs(input),
    });
    if (!result || !result.ok) {
      var error = new Error(result && result.error ?
        result.error : "Clay could not create the worker task");
      error.code = "LIVE_UI_REPORT_DISPATCH_FAILED";
      throw error;
    }
    var task = taskGraph.findTask(input.session, result.orchestrationTaskId);
    var record = {
      reportId: input.reportId,
      taskId: result.orchestrationTaskId,
      title: input.title,
      status: "working",
      message: "Being worked on.",
      selection: input.selection || null,
      workerSessionId: result.workerSessionId || null,
      workerColor: result.workerColor || (task && task.workerColor) || "#55A7FF",
    };
    recordsFor(input.pairing.pairingId).set(input.reportId, record);
    reportStore.persist(input.session, recordsFor(input.pairing.pairingId));
    return {
      accepted: true,
      reportId: input.reportId,
      taskId: result.orchestrationTaskId,
      title: input.title,
    };
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
    var sanitizedAttachments = liveUiAttachments.sanitizeAttachments(
      msg.payload && msg.payload.attachments);
    if (!sanitizedAttachments.ok) {
      var attachmentError = new Error(sanitizedAttachments.error);
      attachmentError.code = "LIVE_UI_ATTACHMENTS_INVALID";
      throw attachmentError;
    }
    var session = pairSessions.get(pairing.pairingId);
    if (!session) {
      var sessionError = new Error("The pinned Clay session is no longer available");
      sessionError.code = "LIVE_UI_SESSION_GONE";
      throw sessionError;
    }
    var requestedReportId = msg.payload && typeof msg.payload.reportId === "string" ?
      msg.payload.reportId.slice(0, 128) : "";
    var reportId = requestedReportId || crypto.randomUUID();
    var title = reportTitle(text);
    var accepted = ctx.registry.acceptMessage(
      pairing.pairingId,
      msg.clientMessageId,
      function () {
        var existing = requestedReportId ?
          recordsFor(pairing.pairingId).get(requestedReportId) : null;
        if (existing && existing.dismissed) existing = null;
        if (requestedReportId && !existing) {
          var missingError = new Error("The selected Live UI worker is no longer available");
          missingError.code = "LIVE_UI_REPORT_GONE";
          throw missingError;
        }
        var input = {
          attachments: sanitizedAttachments.packet,
          attachmentImageRefs: liveUiAttachments.storeImages(
            sanitizedAttachments.packet, ctx, session),
          clientMessageId: msg.clientMessageId,
          diagnostics: sanitizedDiagnostics.packet,
          existing: existing,
          imageFile: storeScreenshot(session, screenshot),
          pairing: pairing,
          reportId: reportId,
          screenshot: screenshot,
          selection: selection,
          session: session,
          text: text,
          title: title,
        };
        return existing ? continueReport(input) : createReport(input);
      }
    );
    var acknowledgment = accepted.acknowledgment;
    var record = recordsFor(pairing.pairingId).get(acknowledgment.reportId);
    if (record) sendReport(pairing, "report.accepted", record);
    ensurePolling();
  }

  function dismiss(ws, msg, pairing) {
    ctx.assertExtensionSender(ws, pairing);
    var reportId = msg.payload && typeof msg.payload.reportId === "string" ?
      msg.payload.reportId.slice(0, 128) : "";
    var accepted = ctx.registry.acceptMessage(
      pairing.pairingId,
      msg.clientMessageId,
      function () {
        var record = recordsFor(pairing.pairingId).get(reportId);
        var session = pairSessions.get(pairing.pairingId);
        if (!record || !session) {
          var missingError = new Error("The selected Live UI worker is no longer available");
          missingError.code = "LIVE_UI_REPORT_GONE";
          throw missingError;
        }
        var task = taskGraph.findTask(session, record.taskId);
        if (taskPresentation(task).status !== "completed") {
          var statusError = new Error("Only a completed Live UI worker card can be removed");
          statusError.code = "LIVE_UI_REPORT_NOT_COMPLETE";
          throw statusError;
        }
        record.dismissed = true;
        reportStore.persist(session, recordsFor(pairing.pairingId));
        return { accepted: true, reportId: reportId };
      }
    );
    ctx.sendTarget(pairing, "report.removed", {
      reportId: accepted.acknowledgment.reportId,
    });
  }

  return {
    clearPair: clearPair,
    dismiss: dismiss,
    handleMessage: handleMessage,
    registerPair: registerPair,
    sendSnapshot: sendSnapshot,
  };
}

module.exports = {
  attachLiveUiReports: attachLiveUiReports,
};
