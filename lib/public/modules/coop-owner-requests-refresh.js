// coop-owner-requests-refresh.js - When the client asks the server for the
// owner-request backlog.
//
// The overview itself is read-only and server-owned (coop-owner-requests.js);
// this module only decides WHEN to ask. Three triggers, no timers:
//
//   1. Coop view activation. Every render of the Coop sections calls
//      ensureOwnerRequestOverview(); the coalescing below turns that stream of
//      renders into at most one request per window.
//   2. Reconnect. A new socket has no overview at all, so the throttle is
//      bypassed outright -- otherwise the panel would sit on data from a
//      socket that no longer exists.
//   3. Owner-facing state change. A projection that could have moved the
//      backlog marks it stale; the next render refetches.
//
// Deliberately NO setInterval and NO setTimeout. A tight timer here would put
// a server query behind every tick whether or not the owner is looking at the
// panel, and a trailing timeout would keep firing after the view closed. The
// stale flag is sticky instead: it stays set until a request actually goes
// out, so a throttled refetch is deferred, never dropped -- and renders in
// this app follow every projection, so the deferred ask lands on the next one.

import { requestOwnerRequestOverview } from './coop-owner-requests.js';

// Long enough that a burst of projections cannot turn into a burst of queries,
// short enough that the backlog the owner is staring at is never meaningfully
// behind the conversation that changed it.
var COALESCE_MS = 5000;

var lastRequestedAt = 0;
var asked = false;
var stale = true;

function nowFrom(options) {
  if (options && typeof options.now === 'number') return options.now;
  return Date.now();
}

function send(at) {
  if (!requestOwnerRequestOverview()) return false;
  lastRequestedAt = at;
  asked = true;
  stale = false;
  return true;
}

// The activation caller. Returns true only when a request actually went out,
// so a disconnected socket is never mistaken for a completed fetch.
export function ensureOwnerRequestOverview(options) {
  var at = nowFrom(options);
  if (asked && !stale) return false;
  // A first ask is never throttled: an empty panel must not wait out a window
  // it never opened.
  if (asked && at - lastRequestedAt < COALESCE_MS) return false;
  return send(at);
}

// Something that could have changed the owner-facing backlog arrived. Sticky:
// cleared only by an actual request, so a coalesced refetch is postponed to the
// next activation rather than lost.
export function invalidateOwnerRequestOverview() {
  stale = true;
}

// A new socket. Whatever we hold was fetched over a connection that is gone, so
// this bypasses the window rather than coalescing against it.
export function notifyOwnerRequestsReconnect(options) {
  stale = true;
  return send(nowFrom(options));
}

// Test seam: module state is process-wide, and every test wants a clean slate.
export function resetOwnerRequestRefresh() {
  lastRequestedAt = 0;
  asked = false;
  stale = true;
}
