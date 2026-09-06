import { store } from './store.js';

function line(parent, text) {
  var item = document.createElement("div");
  item.textContent = text;
  parent.appendChild(item);
  return item;
}

function time(value) {
  return value ? new Date(value).toLocaleString() : "No recorded turn";
}

function reason(value) {
  return String(value || "Context unavailable").replace(/_/g, " ");
}

export function renderCoordinatorDetails(parent, node) {
  if (node.activity) {
    var activity = line(parent, node.activity);
    activity.className = "coop-coordinator-activity";
  }
  var data = node.transparency;
  if (!data) return;
  var details = document.createElement("details");
  details.className = "coop-coordinator-details";
  var ref = node.sessionRef || {};
  var key = ref.projectId + ":" + ref.sessionStorageId;
  details.open = !!(store.get("coordinatorDetailsOpen") || {})[key];
  details.addEventListener("toggle", function () {
    var previous = store.get("coordinatorDetailsOpen") || {};
    if (!!previous[key] === !!details.open) return;
    var next = Object.assign({}, previous);
    if (details.open) next[key] = true;
    else delete next[key];
    store.set({ coordinatorDetailsOpen: next });
  });
  var summary = document.createElement("summary");
  summary.textContent = "Coordinator details";
  details.appendChild(summary);
  line(details, [data.vendor, data.model].filter(Boolean).join(" · ") || "Provider not selected");
  line(details, "Last activity: " + time(data.updatedAt));
  line(details, data.pendingAssignmentCount + " assignments awaiting acceptance · " +
    data.pendingReportCount + " pending reports");
  var context = data.context;
  if (!context) line(details, "Project context has not been supplied to a provider yet.");
  else {
    line(details, "Latest context attempt: " + time(context.at));
    line(details, context.state === "supplied" ? "Supplied to provider; understanding is not verified." :
      "Provider input: " + reason(context.state));
    if (!context.contextReady) line(details, "Work blocked: " + reason(context.reason));
    if (context.persistenceFailed) line(details, "The context receipt could not be saved.");
    var manifest = context.instructions || {};
    line(details, "Governing instructions" + (manifest.complete ? " — complete at this attempt" : " — incomplete"));
    (manifest.files || []).forEach(function (file) {
      line(details, file.path + " · " + String(file.digest || "").slice(0, 10));
    });
    (manifest.problems || []).forEach(function (problem) {
      line(details, (problem.path || "Instructions") + ": " + reason(problem.reason));
    });
    (context.missing || []).forEach(function (file) { line(details, "Missing: " + file); });
    if ((manifest.supporting || []).length) {
      line(details, "Supporting documents (retrieve when needed)");
      manifest.supporting.forEach(function (file) {
        line(details, file.path + (file.available ? "" : " — unavailable"));
      });
    }
  }
  if (data.events.length) {
    line(details, "Recent recorded activity");
    data.events.forEach(function (event) {
      line(details, time(event.at) + " · " + [event.title, reason(event.type), event.summary].filter(Boolean).join(" · "));
    });
  }
  parent.appendChild(details);
}
