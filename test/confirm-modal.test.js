var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function classList(node, initial) {
  var values = String(initial || "").split(/\s+/).filter(Boolean);
  return {
    add: function (name) { if (values.indexOf(name) === -1) values.push(name); node.className = values.join(" "); },
    remove: function (name) { values = values.filter(function (value) { return value !== name; }); node.className = values.join(" "); },
    contains: function (name) { return values.indexOf(name) !== -1; },
  };
}

function element(id, initialClass, documentRef) {
  var node = {
    id: id,
    className: initialClass || "",
    listeners: {},
    textContent: "",
    disabled: false,
  };
  node.classList = classList(node, initialClass);
  node.addEventListener = function (type, handler) {
    node.listeners[type] = (node.listeners[type] || []).concat(handler);
  };
  node.focus = function () { documentRef.activeElement = node; node.focusCount = (node.focusCount || 0) + 1; };
  node.click = function () {
    var handlers = node.listeners.click || [];
    for (var i = 0; i < handlers.length; i++) handlers[i]({ preventDefault: function () {} });
  };
  return node;
}

function modalDom() {
  var documentRef = { activeElement: null };
  var opener = element("opener", "", documentRef);
  var modal = element("confirm-modal", "hidden", documentRef);
  var text = element("confirm-text", "", documentRef);
  var ok = element("confirm-ok", "confirm-btn confirm-delete", documentRef);
  var cancel = element("confirm-cancel", "confirm-btn confirm-cancel", documentRef);
  var backdrop = element("confirm-backdrop", "confirm-backdrop", documentRef);
  var elements = {
    "confirm-modal": modal,
    "confirm-text": text,
    "confirm-ok": ok,
    "confirm-cancel": cancel,
  };
  modal.querySelector = function (selector) { return selector === ".confirm-backdrop" ? backdrop : null; };
  modal.querySelectorAll = function () { return [cancel, ok]; };
  modal.contains = function (candidate) {
    return candidate === modal || candidate === text || candidate === ok || candidate === cancel || candidate === backdrop;
  };
  documentRef.getElementById = function (id) { return elements[id] || null; };
  documentRef.contains = function (candidate) {
    return candidate === opener || modal.contains(candidate);
  };
  documentRef.activeElement = opener;
  return { document: documentRef, opener: opener, modal: modal, text: text, ok: ok, cancel: cancel, backdrop: backdrop };
}

function keydown(dom, key, shiftKey, documentHandler) {
  var prevented = 0;
  var propagationStopped = false;
  var handlers = dom.modal.listeners.keydown || [];
  var event = {
    key: key,
    shiftKey: !!shiftKey,
    preventDefault: function () { prevented++; },
    stopPropagation: function () { propagationStopped = true; },
  };
  for (var i = 0; i < handlers.length; i++) handlers[i](event);
  if (!propagationStopped && typeof documentHandler === "function") documentHandler(event);
  return prevented;
}

async function loadModal(dom) {
  globalThis.document = dom.document;
  var url = pathToFileURL(path.join(__dirname, "..", "lib", "public", "modules", "confirm-modal.js")).href;
  return import(url + "?confirm-modal-test=" + Date.now() + Math.random());
}

test("shared confirmation markup exposes a named and described modal dialog", function () {
  var html = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "index.html"), "utf8");
  var start = html.indexOf('<div id="confirm-modal"');
  var end = html.indexOf('<div id="skill-install-modal"', start);
  var modal = html.slice(start, end);
  assert.match(modal, /role="dialog"/);
  assert.match(modal, /aria-modal="true"/);
  assert.match(modal, /aria-labelledby="confirm-title"/);
  assert.match(modal, /aria-describedby="confirm-text"/);
  assert.match(modal, /id="confirm-title"/);
});

test("opening the shared modal enters focus and traps forward and reverse Tab", async function () {
  var dom = modalDom();
  var modal = await loadModal(dom);
  modal.initConfirmModal();
  modal.showConfirm("Proceed with the action?", function () {}, "Proceed", false, "Back");

  assert.equal(dom.modal.classList.contains("hidden"), false);
  assert.equal(dom.document.activeElement, dom.cancel, "the safe cancel action receives entry focus");

  dom.ok.focus();
  assert.equal(keydown(dom, "Tab", false), 1);
  assert.equal(dom.document.activeElement, dom.cancel, "Tab wraps from the last control to the first");

  dom.cancel.focus();
  assert.equal(keydown(dom, "Tab", true), 1);
  assert.equal(dom.document.activeElement, dom.ok, "Shift+Tab wraps from the first control to the last");
});

test("Escape cancels without callback and restores focus; confirm still fires once", async function () {
  var dom = modalDom();
  var modal = await loadModal(dom);
  var confirmed = 0;
  var underlyingEscapeCount = 0;
  modal.initConfirmModal();
  modal.showConfirm("Cancel this action?", function () { confirmed++; });
  assert.equal(keydown(dom, "Escape", false, function () { underlyingEscapeCount++; }), 1);
  assert.equal(dom.modal.classList.contains("hidden"), true);
  assert.equal(confirmed, 0);
  assert.equal(underlyingEscapeCount, 0, "Escape never reaches the underlying document-level modal handler");
  assert.equal(dom.document.activeElement, dom.opener);

  modal.showConfirm("Confirm this action?", function () { confirmed++; });
  dom.ok.click();
  dom.ok.click();
  assert.equal(confirmed, 1);
  assert.equal(dom.modal.classList.contains("hidden"), true);
  assert.equal(dom.document.activeElement, dom.opener);
});
