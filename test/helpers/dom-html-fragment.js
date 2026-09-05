// Give lightweight DOM fixtures real HTML fragment parsing. The application
// now mounts its tab markup through innerHTML + firstChild; returning an empty
// children array for nonempty HTML does not represent browser behavior.
var parseFragment = require("parse5").parseFragment;

function installHtmlFragment(node, createElement) {
  function convert(parsed) {
    if (parsed.nodeName === "#text") return { nodeType: 3, textContent: parsed.value,
      children: [], className: "" };
    if (!parsed.tagName) return null;
    var child = createElement(parsed.tagName);
    (parsed.attrs || []).forEach(function (attr) {
      child.setAttribute(attr.name, attr.value);
      if (attr.name === "class") child.className = attr.value;
    });
    (parsed.childNodes || []).forEach(function (entry) {
      var converted = convert(entry);
      if (converted) child.appendChild(converted);
    });
    return child;
  }
  Object.defineProperty(node, "firstChild", {
    get: function () { return node.children[0] || null; },
  });
  Object.defineProperty(node, "innerHTML", {
    get: function () { return node._innerHTML || ""; },
    set: function (value) {
      node._innerHTML = String(value);
      node.children = [];
      delete node._textContent;
      parseFragment(node._innerHTML).childNodes.forEach(function (parsed) {
        var child = convert(parsed);
        if (child) node.appendChild(child);
      });
    },
  });
  // These fixtures trigger controls through their recorded handlers. Selector
  // wiring is outside their scope, as in the existing workspace DOM harness.
  if (!node.querySelectorAll) node.querySelectorAll = function () { return []; };
  return node;
}

module.exports = { installHtmlFragment: installHtmlFragment };
