var { execFile } = require("child_process");
var skillDiscovery = require("../skill-discovery");

function injectSharedSkillContent(message, skills) {
  var text = "";
  if (typeof message === "string") text = message;
  else if (Array.isArray(message)) {
    for (var i = 0; i < message.length; i++) {
      if (message[i] && message[i].type === "text") text += "\n" + (message[i].text || "");
    }
  }
  var content = skillDiscovery.readReferencedSkills(text, skills, 32768);
  if (!content) return message;
  var appendix = "\n\nUse the following shared skill instructions for this turn:\n" + content;
  if (typeof message === "string") return message + appendix;
  if (!Array.isArray(message)) return message;
  var cloned = message.slice();
  for (var ci = 0; ci < cloned.length; ci++) {
    if (cloned[ci] && cloned[ci].type === "text") {
      cloned[ci] = Object.assign({}, cloned[ci], { text: (cloned[ci].text || "") + appendix });
      return cloned;
    }
  }
  cloned.unshift({ type: "text", text: appendix.trim() });
  return cloned;
}

var _uuidCounter = 0;
function generateUuid() {
  var ts = Date.now().toString(36);
  var cnt = (++_uuidCounter).toString(36);
  var rnd = Math.random().toString(36).substring(2, 8);
  return "kiro-" + ts + "-" + cnt + "-" + rnd;
}

function waitMs(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function waitForProcessExit(proc, timeoutMs) {
  return new Promise(function(resolve) {
    if (!proc) { resolve(true); return; }
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(true); return; }
    var done = false, timer = null;
    function cleanup() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      proc.removeListener("exit", onDone);
      proc.removeListener("close", onDone);
    }
    function onDone() { cleanup(); resolve(true); }
    proc.once("exit", onDone);
    proc.once("close", onDone);
    timer = setTimeout(function() { cleanup(); resolve(false); }, timeoutMs || 5000);
  });
}

function createShutdownError() {
  var err = new Error("Kiro adapter is shutting down, retry shortly");
  err.code = "KIRO_ADAPTER_SHUTTING_DOWN";
  return err;
}

// Detect Kiro "not logged in" errors from an error object or message string.
function isKiroAuthError(text, errObj) {
  if (errObj && errObj.kiroErrorInfo === "unauthorized") return true;
  return /not logged in|expired token|token has expired|please (?:sign in|log ?in) again|reauthenticate|kiro-cli login|no valid credentials|unauthorized|forbidden|auth refresh callback failed|failed to verify authentication|\b401\b/i.test(String(text || ""));
}

// Map an ACP tool kind to a Clay-facing tool name so the UI can pick an icon.
function toolNameForKind(kind, title) {
  switch (kind) {
    case "execute": return "Bash";
    case "read": return "Read";
    case "edit": return "Edit";
    case "delete": return "Edit";
    case "move": return "Edit";
    case "search": return "Grep";
    case "fetch": return "WebFetch";
    case "think": return "Think";
    default: return title || "Tool";
  }
}

function normalizePlanStatus(status) {
  if (status === "in_progress" || status === "inProgress") return "in_progress";
  if (status === "completed") return "completed";
  return "pending";
}

// Fetch the model catalog from the CLI (JSON) so the picker mirrors Claude's
// dynamic listing. Internal/deprecated entries are filtered out for a clean UX.
function fetchModelsViaCli(binaryPath, cwd) {
  return new Promise(function(resolve) {
    execFile(binaryPath, ["chat", "--list-models", "--format", "json"], {
      timeout: 20000,
      cwd: cwd || process.cwd(),
      maxBuffer: 4 * 1024 * 1024,
    }, function(err, stdout) {
      if (err || !stdout) { resolve(null); return; }
      try {
        var parsed = JSON.parse(stdout);
        var models = [];
        var contextWindows = {};
        var list = (parsed && parsed.models) || [];
        for (var i = 0; i < list.length; i++) {
          var m = list[i];
          var desc = m.description || "";
          if (/\[Internal\]|\[Deprecated\]/i.test(desc)) continue;
          if (m.model_id) {
            models.push(m.model_id);
            if (typeof m.context_window_tokens === "number") contextWindows[m.model_id] = m.context_window_tokens;
          }
        }
        resolve({ models: models, defaultModel: parsed.default_model || "auto", contextWindows: contextWindows });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// Kiro's v3 ACP engine delegates token refresh to the host through the
// _kiro/auth/getAccessToken request. The CLI exposes a narrow internal command
// that returns the active profile's refreshed KAS token as JSON.
function fetchKasTokenViaCli(binaryPath, cwd) {
  return new Promise(function(resolve, reject) {
    execFile(binaryPath, ["chat", "_", "get-kas-token"], {
      timeout: 20000,
      cwd: cwd || process.cwd(),
      maxBuffer: 1024 * 1024,
    }, function(err, stdout) {
      if (err) { reject(err); return; }
      try {
        var parsed = JSON.parse(stdout);
        if (!parsed || parsed.kind !== "getKasToken" || !parsed.data || !parsed.data.accessToken) {
          throw new Error("Unexpected Kiro token response");
        }
        resolve(parsed.data);
      } catch (e) {
        reject(new Error("Failed to parse Kiro access token response: " + e.message));
      }
    });
  });
}


module.exports = {
  createShutdownError: createShutdownError,
  fetchKasTokenViaCli: fetchKasTokenViaCli,
  fetchModelsViaCli: fetchModelsViaCli,
  generateUuid: generateUuid,
  injectSharedSkillContent: injectSharedSkillContent,
  isKiroAuthError: isKiroAuthError,
  normalizePlanStatus: normalizePlanStatus,
  toolNameForKind: toolNameForKind,
  waitForProcessExit: waitForProcessExit,
  waitMs: waitMs,
};
