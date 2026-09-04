// Per-browser-tab conversation state. sessionStorage is intentionally scoped
// to one open tab so separate Clay chats do not overwrite each other's view.

function storageKey(slug) {
  return "clay-active-session:" + String(slug || "");
}

function urlRefValue(ref) {
  if (!ref || !ref.projectId || !ref.sessionStorageId) return "";
  return String(ref.projectId) + "~" + String(ref.sessionStorageId);
}

function refFromUrl(slug) {
  if (typeof location === "undefined" || !location.search) return null;
  if (location.pathname !== "/p/" + slug + "/") return null;
  try {
    var raw = new URLSearchParams(location.search).get("sessionRef") || "";
    var divider = raw.indexOf("~");
    if (divider <= 0 || divider === raw.length - 1) return null;
    return { projectId: raw.slice(0, divider), sessionStorageId: raw.slice(divider + 1) };
  } catch (e) {
    return null;
  }
}

export function readUrlSessionRef(slug) {
  return refFromUrl(slug);
}

export function sameSessionRef(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return String(a.projectId || "") === String(b.projectId || "") &&
    String(a.sessionStorageId || "") === String(b.sessionStorageId || "");
}

export function sessionRefUrlSuffix(ref) {
  var value = urlRefValue(ref);
  return value ? "?sessionRef=" + encodeURIComponent(value) : "";
}

// Kept pure so project changes can make the same history decision in desktop
// and PWA contexts without coupling tab restoration to browser globals.
export function projectNavigationHistoryUpdate(slug, options, isPwaStandalone) {
  return {
    method: isPwaStandalone ? "replaceState" : "pushState",
    url: "/p/" + slug + "/" + sessionRefUrlSuffix(options && options.sessionRef),
  };
}

export function syncTabSessionRefUrl(slug, ref) {
  if (typeof history === "undefined" || typeof location === "undefined") return;
  if (location.pathname !== "/p/" + slug + "/") return;
  try {
    var url = new URL(location.href);
    var value = urlRefValue(ref);
    if (value) url.searchParams.set("sessionRef", value);
    else url.searchParams.delete("sessionRef");
    history.replaceState(null, "", url.pathname + url.search);
  } catch (e) {}
}

export function rememberTabSession(slug, sessionId, cliSessionId) {
  if (!slug || !sessionId) return;
  try {
    var sessionRef = refFromUrl(slug);
    var existing = sessionStorage.getItem(storageKey(slug));
    if (!sessionRef && existing) {
      try {
        var saved = JSON.parse(existing);
        if (saved && saved.localId === sessionId && saved.sessionRef) sessionRef = saved.sessionRef;
      } catch (e) {}
    }
    sessionStorage.setItem(storageKey(slug), JSON.stringify({
      localId: sessionId,
      stableId: cliSessionId || null,
      sessionRef: sessionRef,
      visitedAt: Date.now(),
    }));
    syncTabSessionRefUrl(slug, sessionRef);
  } catch (e) {}
}

// A global Coop row must survive the project switch that follows its resolver
// response.  Keep its durable identity beside the project-local runtime id;
// `readTabSession` intentionally continues to return the stable id that the
// target project's websocket restore path already understands.
export function rememberTabSessionRef(slug, sessionRef, localId) {
  if (!slug || !sessionRef || !sessionRef.projectId || !sessionRef.sessionStorageId) return;
  try {
    sessionStorage.setItem(storageKey(slug), JSON.stringify({
      localId: typeof localId === "number" ? localId : null,
      stableId: sessionRef.sessionStorageId,
      sessionRef: {
        projectId: sessionRef.projectId,
        sessionStorageId: sessionRef.sessionStorageId,
      },
      visitedAt: Date.now(),
    }));
    syncTabSessionRefUrl(slug, sessionRef);
  } catch (e) {}
}

export function readTabSession(slug) {
  if (!slug) return null;
  try {
    var urlRef = refFromUrl(slug);
    if (urlRef) return urlRef.sessionStorageId;
    var raw = sessionStorage.getItem(storageKey(slug));
    if (!raw) return null;
    try {
      var saved = JSON.parse(raw);
      if (typeof saved === "number" && saved > 0) return String(saved);
      if (saved && saved.stableId) return String(saved.stableId);
      if (saved && saved.localId) return String(saved.localId);
    } catch (e) {
      var legacyId = parseInt(raw, 10);
      if (legacyId > 0) return String(legacyId);
    }
    return null;
  } catch (e) {
    return null;
  }
}

export function readTabSessionRef(slug) {
  if (!slug) return null;
  try {
    var urlRef = refFromUrl(slug);
    if (urlRef) return urlRef;
    var raw = sessionStorage.getItem(storageKey(slug));
    if (!raw) return null;
    var saved = JSON.parse(raw);
    var ref = saved && saved.sessionRef;
    if (!ref || typeof ref.projectId !== "string" || typeof ref.sessionStorageId !== "string") return null;
    return { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId };
  } catch (e) {
    return null;
  }
}

// Project icons represent a parent plus its worktrees. Find which exact member
// this browser tab visited last so returning through the family icon does not
// silently jump from a worktree back to the parent checkout.
export function readMostRecentTabProject(slugs) {
  var list = Array.isArray(slugs) ? slugs : [];
  var bestSlug = null;
  var bestVisitedAt = -1;
  try {
    for (var i = 0; i < list.length; i++) {
      var slug = list[i];
      var raw = sessionStorage.getItem(storageKey(slug));
      if (!raw) continue;
      var saved = null;
      try { saved = JSON.parse(raw); } catch (e) {}
      var hasSession = typeof saved === "number" && saved > 0 ||
        saved && (saved.stableId || saved.localId);
      if (!hasSession) continue;
      var visitedAt = saved && typeof saved.visitedAt === "number" ? saved.visitedAt : 0;
      if (bestSlug === null || visitedAt > bestVisitedAt) {
        bestSlug = slug;
        bestVisitedAt = visitedAt;
      }
    }
  } catch (e) {
    return null;
  }
  return bestSlug;
}

export function forgetTabSession(slug) {
  if (!slug) return;
  try {
    sessionStorage.removeItem(storageKey(slug));
    syncTabSessionRefUrl(slug, null);
  } catch (e) {}
}

export function forgetTabSessionRefForProject(slug, projectId) {
  var ref = readTabSessionRef(slug);
  if (!ref || String(ref.projectId) !== String(projectId || "")) return false;
  forgetTabSession(slug);
  return true;
}
