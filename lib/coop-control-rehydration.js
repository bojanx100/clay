// Transcript-free rehydration validation and bounded exam evidence.

var crypto = require("crypto");
var continuity = require("./coop-control-continuity");
var validation = require("./coop-control-store-validation");

var MAX_RESUME_INPUT_BYTES = continuity.MAX_PACKET_BYTES + 512;

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function examineRehydrationPacket(value) {
  var packet = continuity.normalizeContinuityPacket(value);
  var canonicalJson = continuity.canonicalPacketJson(packet);
  return {
    passed: true,
    schemaVersion: continuity.SCHEMA_VERSION,
    digest: digest(canonicalJson),
    byteLength: Buffer.byteLength(canonicalJson, "utf8"),
    counts: {
      authorities: packet.authorities.length,
      bindings: packet.bindings.length,
      decisions: packet.decisions.length,
      executions: packet.executions.length,
      learningReferences: packet.learningReferences.length,
      objectives: packet.objectives.length,
      ownerRequests: packet.ownerRequests.length,
      tasks: packet.tasks.length,
    },
  };
}

function parseCheckpointJson(text) {
  var value;
  try { value = JSON.parse(text); }
  catch (cause) {
    throw validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
      "A continuity checkpoint contains unreadable JSON.", cause);
  }
  return value;
}

function examineStoredCheckpoint(text, expectedDigest) {
  var packet = parseCheckpointJson(text);
  var exam;
  try { exam = examineRehydrationPacket(packet); }
  catch (cause) {
    throw validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
      "A continuity checkpoint violates the transcript-free schema.", cause);
  }
  if (exam.digest !== expectedDigest || continuity.canonicalPacketJson(packet) !== text) {
    throw validation.taggedError("COOP_CONTROL_STORE_LOGICAL_CORRUPTION",
      "A continuity checkpoint digest or canonical form is inconsistent.");
  }
  return { packet: continuity.normalizeContinuityPacket(packet), exam: exam };
}

function restoreContinuityState(value) {
  var packet = continuity.normalizeContinuityPacket(value);
  return {
    authorities: packet.authorities,
    bindings: packet.bindings,
    decisions: packet.decisions,
    executions: packet.executions,
    learningReferences: packet.learningReferences,
    objectives: packet.objectives,
    ownerRequests: packet.ownerRequests,
    tasks: packet.tasks,
  };
}

function buildResumeInput(value) {
  var packet = continuity.normalizeContinuityPacket(value);
  var input = [
    "Resume this controlled execution from the durable continuity state below.",
    "Treat ownerRequests as unanswered. Continue only the admitted state represented by these records.",
    continuity.canonicalPacketJson(packet),
  ].join("\n");
  if (Buffer.byteLength(input, "utf8") > MAX_RESUME_INPUT_BYTES) {
    throw validation.taggedError("COOP_CONTROL_REHYDRATION_INPUT_TOO_LARGE",
      "The bounded continuity resume input exceeds its runtime limit.");
  }
  return input;
}

module.exports = {
  MAX_RESUME_INPUT_BYTES: MAX_RESUME_INPUT_BYTES,
  buildResumeInput: buildResumeInput,
  examineRehydrationPacket: examineRehydrationPacket,
  examineStoredCheckpoint: examineStoredCheckpoint,
  restoreContinuityState: restoreContinuityState,
  runTranscriptFreeExam: examineRehydrationPacket,
};
