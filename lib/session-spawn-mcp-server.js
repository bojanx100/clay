// Session Spawn MCP Server for Clay
// Provides SDK-free tool definitions for agent-driven session fan-out.

var z;
try { z = require("zod"); } catch (e) { z = null; }

function buildShape(props, required) {
  if (!z) return {};
  var shape = {};
  var keys = Object.keys(props);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var prop = props[key];
    var field;
    if (prop.type === "number") field = z.number();
    else if (prop.type === "boolean") field = z.boolean();
    else if (prop.enum) field = z.enum(prop.enum);
    else field = z.string();
    if (prop.description) field = field.describe(prop.description);
    if (!required || required.indexOf(key) === -1) field = field.optional();
    shape[key] = field;
  }
  return shape;
}

function getToolDefs(handlers) {
  return [
    {
      name: "spawn_sessions",
      description: "Create sibling work sessions in this project. Each child session starts with its own prompt and runs independently; results can be polled with check_spawned_sessions. Spawned children cannot spawn further sessions.",
      inputSchema: buildShape({
        sessions: { type: "string", description: "JSON array of objects: [{\"title\":\"Task title\",\"prompt\":\"Task instructions\"}]" },
        vendor: { type: "string", description: "Optional vendor id. Defaults to the parent session vendor, then the project default." },
      }, ["sessions"]),
      handler: function (args) {
        return handlers.spawn(args || {});
      },
    },
    {
      name: "check_spawned_sessions",
      description: "Check the status of sessions spawned by this session. By default only direct children of the calling session are returned.",
      inputSchema: buildShape({
        parentOnly: { type: "boolean", description: "When false, return all spawned sessions in this project. Defaults to true." },
      }),
      handler: function (args) {
        return handlers.check(args || {});
      },
    },
  ];
}

module.exports = {
  buildShape: buildShape,
  getToolDefs: getToolDefs,
};
