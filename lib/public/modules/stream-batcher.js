// Bounded per-frame delivery for assistant streaming.

var MAX_STREAM_CHUNK_CHARS = 16 * 1024;

export function takeStreamChunk(buffer) {
  var value = typeof buffer === "string" ? buffer : "";
  if (!value) return { chunk: "", remaining: "" };
  var end = Math.min(value.length, MAX_STREAM_CHUNK_CHARS);
  return { chunk: value.slice(0, end), remaining: value.slice(end) };
}

export { MAX_STREAM_CHUNK_CHARS };
