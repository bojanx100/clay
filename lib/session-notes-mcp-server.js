// Sticky-note memory tools for project sessions.

var buildShape = require("./session-spawn-mcp-server").buildShape;

var MEMORY_CONTRACT = "Shared project memory that persists across sessions and is visible to the user and other Clay agents. People may use the board freely. As a Clay agent, use notes specifically for actionable or durable work memory: checklists and to-do lists, work goals, handoffs, unfinished work, durable decisions and constraints, and knowledge that should still be available after the current session ends. Every note starts with a concise plain-text title on the first line. Add a detailed body whenever another worker would otherwise need to reconstruct the context. Keep one coherent topic per note, update an existing note instead of adding a near-duplicate, and delete notes that stop being true. Do not use notes as a transcript, a routine progress log, or an announcement of your own activity.";

function getToolDefs(handlers) {
  return [
    {
      name: "list_notes",
      description: MEMORY_CONTRACT + " List the active notes before writing when you need to avoid duplicates or inspect full memory beyond the injected summary.",
      inputSchema: buildShape({}),
      handler: function (args) { return handlers.list(args || {}); },
    },
    {
      name: "write_note",
      description: MEMORY_CONTRACT + " Create a new note, or update an existing note by id. Long task and handoff notes are allowed, with a generous 20000-character abuse guard.",
      inputSchema: buildShape({
        id: { type: "string", description: "Existing note id to update. Omit to create a note." },
        text: { type: "string", description: "Sticky-note text. Put the title on the first line, followed by the detailed handoff body. The board permits up to 20000 characters." },
        color: { type: "string", enum: ["yellow", "blue", "green", "pink", "orange", "purple"], description: "Optional sticky-note color." },
      }, ["text"]),
      handler: function (args) { return handlers.write(args || {}); },
    },
    {
      name: "remove_note",
      description: MEMORY_CONTRACT + " Remove a note created by this same session when it is no longer true. Notes created by users or other sessions cannot be removed.",
      inputSchema: buildShape({
        id: { type: "string", description: "Id of the note to remove." },
      }, ["id"]),
      handler: function (args) { return handlers.remove(args || {}); },
    },
  ];
}

module.exports = {
  MEMORY_CONTRACT: MEMORY_CONTRACT,
  getToolDefs: getToolDefs,
};
