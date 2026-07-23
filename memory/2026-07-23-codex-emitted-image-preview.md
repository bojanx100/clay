# Debug report: Codex emitted image preview

- **Symptom:** Images emitted from a Codex dynamic tool, including `nodeRepl.emitImage`, appeared as completed tool calls without an inline preview.
- **Root cause:** Codex can deliver image results through two item shapes. Dynamic tool calls may wrap MCP `content` blocks in JSON text, while native `mcpToolCall` items expose the blocks directly under `item.result.content`. Clay's dynamic branch only recognized direct `inputImage` items, and its native MCP branch explicitly extracted only `c.text`, discarding image blocks.
- **Fix:** Normalize both serialized and direct MCP content blocks at the Codex adapter boundary, converting images to Clay's existing `{ mediaType, data }` representation while preserving text.
- **Evidence:** The original captured session demonstrated the serialized form. A post-restart live test demonstrated the direct `mcpToolCall` form and persisted an empty tool result before the second fix. Regression tests now reproduce both payloads.
- **Regression tests:** `test/codex-adapter-routing.test.js`, "Codex extracts images wrapped in an MCP JSON tool result" and "Codex preserves image blocks from a completed MCP tool call".
- **Related:** Earlier fixes handled direct Codex `inputImage`, image-generation items, persistence, and client expansion. They did not cover images nested in serialized MCP results.
- **Status:** DONE
