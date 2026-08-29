// Session-bound access to the source of a Clay session handoff.

var z;
try { z = require("zod"); } catch (e) { z = null; }

function buildShape(props) {
  if (!z) return {};
  var shape = {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) {
    var prop = props[keys[i]];
    var field = prop.type === "number" ? z.number() : z.string();
    if (prop.description) field = field.describe(prop.description);
    shape[keys[i]] = field.optional();
  }
  return shape;
}

var TOOL_DESCRIPTION =
  "This session was continued from another agent's session via a context snapshot. " +
  "That snapshot omitted tool calls and older turns. Read the original Clay session record directly, including user messages, assistant text, and summarized tool calls, regardless of which vendor produced it.";

function getToolDefs(handlers) {
  return [
    {
      name: "read_handoff_source",
      description: TOOL_DESCRIPTION,
      inputSchema: buildShape({
        offset: {
          type: "number",
          description: "Skip the first N history entries. Omit to return the last limit entries.",
        },
        limit: {
          type: "number",
          description: "Maximum history entries to return. Defaults to 30 and is capped at 100.",
        },
        sourceSessionId: {
          type: "string",
          description: "Source session in this session's handoff chain. Omit to read the immediate source.",
        },
      }),
      handler: function (args) { return handlers.read(args || {}); },
    },
  ];
}

module.exports = {
  TOOL_DESCRIPTION: TOOL_DESCRIPTION,
  getToolDefs: getToolDefs,
};
