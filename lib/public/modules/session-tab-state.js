// Per-browser-tab conversation state. sessionStorage is intentionally scoped
// to one open tab so separate Clay chats do not overwrite each other's view.

function storageKey(slug) {
  return "clay-active-session:" + String(slug || "");
}

export function rememberTabSession(slug, sessionId, cliSessionId) {
  if (!slug || !sessionId) return;
  try {
    sessionStorage.setItem(storageKey(slug), JSON.stringify({
      localId: sessionId,
      stableId: cliSessionId || null,
    }));
  } catch (e) {}
}

export function readTabSession(slug) {
  if (!slug) return null;
  try {
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

export function forgetTabSession(slug) {
  if (!slug) return;
  try {
    sessionStorage.removeItem(storageKey(slug));
  } catch (e) {}
}
