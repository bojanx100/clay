// Sticky-note memory tools for project sessions.

var buildShape = require("./session-spawn-mcp-server").buildShape;

var MEMORY_CONTRACT = "Shared project memory on the user's board. One note = one fact, decision, or reminder, written like a real sticky note: a phrase or at most two short sentences. It must be worth a human's attention a week later and stand on its own without the current conversation. Never paragraphs, lists of steps, logs, or announcement notes about your own activity. Update an existing note instead of adding a near-duplicate; delete notes that stop being true.";

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
      description: MEMORY_CONTRACT + " Create a new note, or update an existing note by id. Long board notes are allowed, with a 2000-character abuse guard.",
      inputSchema: buildShape({
        id: { type: "string", description: "Existing note id to update. Omit to create a note." },
        text: { type: "string", description: "Sticky-note text. Keep the register concise even though the board permits up to 2000 characters." },
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
