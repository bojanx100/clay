export var DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export var DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export var MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function getISOWeekNumber(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

export function getWeekStart(date) {
  var d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

export function pad(n) {
  return n < 10 ? "0" + n : String(n);
}

export function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatDateTime(d) {
  return MONTH_NAMES[d.getMonth()].substring(0, 3) + " " + d.getDate() + ", " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

export function cronToHuman(cron) {
  if (!cron) return "";
  var parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  if (parts[1] === "*" && parts[2] === "*") {
    var minStep = detectInterval(parts[0], 60);
    if (minStep) return minStep === 1 ? "Every minute" : "Every " + minStep + " minutes";
  }
  if (parts[2] === "*") {
    var hrStep = detectInterval(parts[1], 24);
    if (hrStep) return hrStep === 1 ? "Every hour" : "Every " + hrStep + " hours";
  }
  var t = pad(parseInt(parts[1], 10)) + ":" + pad(parseInt(parts[0], 10));
  var dow = parts[4];
  var dom = parts[2];
  if (dow === "*" && dom === "*") return "Every day at " + t;
  if (dow === "1-5" && dom === "*") return "Weekdays at " + t;
  if (dom !== "*" && dow === "*") return "Monthly on day " + dom + " at " + t;
  if (dow !== "*" && dom === "*") {
    var ds = dow.split(",").map(function (d) { return DAY_NAMES[parseInt(d, 10)] || d; });
    return "Every " + ds.join(", ") + " at " + t;
  }
  return cron;
}

export function detectInterval(field, max) {
  if (field.indexOf("/") !== -1) return parseInt(field.split("/")[1], 10) || null;
  if (field.indexOf(",") === -1) return null;
  var vals = field.split(",").map(function (v) { return parseInt(v, 10); }).sort(function (a, b) { return a - b; });
  if (vals.length < 2) return null;
  var step = vals[1] - vals[0];
  if (step <= 0) return null;
  for (var i = 1; i < vals.length; i++) {
    if (vals[i] - vals[i - 1] !== step) return null;
  }
  if ((max - vals[vals.length - 1] + vals[0]) !== step) return null;
  return step;
}

export function parseCronSimple(expr) {
  if (!expr) return null;
  var fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  return {
    minutes: parseField(fields[0], 0, 59),
    hours: parseField(fields[1], 0, 23),
    daysOfMonth: parseField(fields[2], 1, 31),
    months: parseField(fields[3], 1, 12),
    daysOfWeek: parseField(fields[4], 0, 6),
  };
}

function parseField(field, min, max) {
  var values = [];
  var parts = field.split(",");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.indexOf("/") !== -1) {
      var sp = part.split("/");
      var step = parseInt(sp[1], 10);
      var rMin = min;
      var rMax = max;
      if (sp[0] !== "*") {
        var rp = sp[0].split("-");
        rMin = parseInt(rp[0], 10);
        rMax = rp.length > 1 ? parseInt(rp[1], 10) : rMin;
      }
      for (var v = rMin; v <= rMax; v += step) values.push(v);
    } else if (part === "*") {
      for (var v2 = min; v2 <= max; v2++) values.push(v2);
    } else if (part.indexOf("-") !== -1) {
      var rp2 = part.split("-");
      for (var v3 = parseInt(rp2[0], 10); v3 <= parseInt(rp2[1], 10); v3++) values.push(v3);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return values;
}
