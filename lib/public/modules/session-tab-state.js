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

export function sessionRefUrlSuffix(ref) {
  var value = urlRefValue(ref);
  return value ? "?sessionRef=" + encodeURIComponent(value) : "";
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
    var sessionRef = null;
    var existing = sessionStorage.getItem(storageKey(slug));
    if (existing) {
      try {
        var saved = JSON.parse(existing);
        if (saved && saved.localId === sessionId && saved.sessionRef) sessionRef = saved.sessionRef;
      } catch (e) {}
    }
    sessionStorage.setItem(storageKey(slug), JSON.stringify({
      localId: sessionId,
      stableId: cliSessionId || null,
      sessionRef: sessionRef,
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
    }));
    syncTabSessionRefUrl(slug, sessionRef);
  } catch (e) {}
}

export function readTabSession(slug) {
  if (!slug) return null;
  try {
    var raw = sessionStorage.getItem(storageKey(slug));
    if (!raw) {
      var urlRef = refFromUrl(slug);
      return urlRef ? urlRef.sessionStorageId : null;
    }
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
    var raw = sessionStorage.getItem(storageKey(slug));
    if (!raw) return refFromUrl(slug);
    var saved = JSON.parse(raw);
    var ref = saved && saved.sessionRef;
    if (!ref || typeof ref.projectId !== "string" || typeof ref.sessionStorageId !== "string") return null;
    return { projectId: ref.projectId, sessionStorageId: ref.sessionStorageId };
  } catch (e) {
    return null;
  }
}

export function forgetTabSession(slug) {
  if (!slug) return;
  try {
    sessionStorage.removeItem(storageKey(slug));
    syncTabSessionRefUrl(slug, null);
  } catch (e) {}
}
