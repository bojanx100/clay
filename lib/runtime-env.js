var SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
var PROTECTED_KEYS = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "XDG_RUNTIME_DIR",
  "NODE_OPTIONS", "TERM", "COLORFGBG",
]);

function isProtectedKey(key) {
  return PROTECTED_KEYS.has(key) || key.indexOf("CLAY_") === 0 ||
    key.indexOf("LD_") === 0 || key.indexOf("DYLD_") === 0;
}

function parseQuotedValue(raw, lineNumber) {
  if (raw.indexOf("\0") !== -1) throw new Error("NUL bytes are not allowed at line " + lineNumber);
  if (raw.charAt(0) === "'") {
    if (raw.length < 2 || raw.charAt(raw.length - 1) !== "'") {
      throw new Error("Unterminated single-quoted value at line " + lineNumber);
    }
    return raw.substring(1, raw.length - 1);
  }
  if (raw.charAt(0) === '"') {
    try { return JSON.parse(raw); }
    catch (e) { throw new Error("Invalid double-quoted value at line " + lineNumber); }
  }
  if (/[;`|]|\$\(|&&/.test(raw)) {
    throw new Error("Unsupported executable syntax at line " + lineNumber);
  }
  return raw;
}

function parseEnvrc(envrc) {
  var result = {};
  var lines = String(envrc || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || line.charAt(0) === "#") continue;
    if (line.indexOf("export ") === 0) line = line.substring(7).trim();
    var eq = line.indexOf("=");
    if (eq < 1) throw new Error("Unsupported syntax at line " + (i + 1));
    var key = line.substring(0, eq).trim();
    if (!SAFE_KEY.test(key)) throw new Error("Invalid variable name at line " + (i + 1));
    result[key] = parseQuotedValue(line.substring(eq + 1).trim(), i + 1);
  }
  return result;
}

function validateEnvString(envrc) {
  try { parseEnvrc(envrc); return null; }
  catch (e) { return e.message || "Invalid environment settings"; }
}

function applyEnv(target, values) {
  var keys = Object.keys(values);
  for (var i = 0; i < keys.length; i++) {
    if (!isProtectedKey(keys[i])) target[keys[i]] = values[keys[i]];
  }
}

function resolveRuntimeEnv(opts) {
  var resolved = Object.assign({}, opts.baseEnv || process.env);
  applyEnv(resolved, parseEnvrc(opts.sharedEnvrc));
  applyEnv(resolved, parseEnvrc(opts.projectEnvrc));
  return resolved;
}

module.exports = {
  parseEnvrc: parseEnvrc,
  validateEnvString: validateEnvString,
  resolveRuntimeEnv: resolveRuntimeEnv,
  isProtectedKey: isProtectedKey,
};
