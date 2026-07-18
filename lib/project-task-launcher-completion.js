var PR_REVIEW_COMPLETION_MARKER = "CLAY_PR_REVIEW_COMPLETE";

function addMarker(markers, marker) {
  if (!marker) return;
  if (markers.indexOf(marker) !== -1) return;
  markers.push(marker);
}

function taskLauncherKind(session) {
  var tl = session && session.taskLauncher;
  if (!tl) return "";
  return tl.autoKind || tl.recipeId || "";
}

function completionMarkersForSession(session, completion) {
  var markers = [];
  var marker = completion && completion.marker ? String(completion.marker) : "";
  addMarker(markers, marker);

  var alternates = completion && completion.alternateMarkers;
  if (Array.isArray(alternates)) {
    for (var i = 0; i < alternates.length; i++) {
      addMarker(markers, alternates[i] ? String(alternates[i]) : "");
    }
  }

  var kind = taskLauncherKind(session);
  if (kind === "pr-review") {
    addMarker(markers, PR_REVIEW_COMPLETION_MARKER);
  }
  return markers;
}

function findCompletionMarker(session, completion, text) {
  var markers = completionMarkersForSession(session, completion);
  var body = String(text || "");
  for (var i = 0; i < markers.length; i++) {
    var marker = markers[i];
    var idx = body.indexOf(marker);
    if (idx !== -1) {
      return { marker: marker, index: idx };
    }
  }
  return null;
}

function shouldCloseCompletedSession(session, completion) {
  if (!session || !session.taskLauncher) return false;
  if (session.taskLauncher.autoLaunch) return true;
  return !!(completion && (completion.archiveSession || completion.closeSession));
}

module.exports = {
  PR_REVIEW_COMPLETION_MARKER: PR_REVIEW_COMPLETION_MARKER,
  completionMarkersForSession: completionMarkersForSession,
  findCompletionMarker: findCompletionMarker,
  shouldCloseCompletedSession: shouldCloseCompletedSession,
};
