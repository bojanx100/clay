export function buildOffsetList(start, step, max) {
  var vals = [];
  var v = start % max;
  for (var i = 0; i < max; i += step) {
    vals.push(v);
    v = (v + step) % max;
  }
  vals.sort(function (a, b) { return a - b; });
  return vals.join(",");
}

export function buildCreateCronFromOptions(options) {
  if (!options || !options.selectedDate) return null;

  var h = options.hour;
  var m = options.minute;
  var recurrence = options.recurrence || "none";
  var selectedDate = options.selectedDate;
  var dow = selectedDate.getDay();
  var dom = selectedDate.getDate();
  var month = selectedDate.getMonth() + 1;
  var intervalMins = intervalMinutesFromOptions(options.interval, options.intervalCustom);

  if (intervalMins > 0 && recurrence === "none") {
    if (intervalMins < 60) return buildOffsetList(m, intervalMins, 60) + " * * * *";
    var intHrs = Math.floor(intervalMins / 60);
    return String(m) + " " + buildOffsetList(h, intHrs, 24) + " * * *";
  }

  if (recurrence === "none" && intervalMins === 0) return null;

  var minField = String(m);
  var hourField = String(h);
  if (intervalMins > 0 && intervalMins < 60) {
    minField = buildOffsetList(m, intervalMins, 60);
    hourField = "*";
  } else if (intervalMins >= 60) {
    var intHrs2 = Math.floor(intervalMins / 60);
    minField = String(m);
    hourField = buildOffsetList(h, intHrs2, 24);
  }

  if (recurrence === "daily") return minField + " " + hourField + " * * *";
  if (recurrence === "weekly") return minField + " " + hourField + " * * " + dow;
  if (recurrence === "biweekly") {
    var weekNum = Math.ceil(dom / 7);
    return minField + " " + hourField + " " + ((weekNum - 1) * 7 + 1) + "-" + (weekNum * 7) + " * " + dow;
  }
  if (recurrence === "yearly") return minField + " " + hourField + " " + dom + " " + month + " *";
  if (recurrence === "monthly") return minField + " " + hourField + " " + dom + " * *";
  if (recurrence === "weekdays") return minField + " " + hourField + " * * 1-5";

  if (recurrence === "custom" && options.customConfirmed) {
    return buildCustomCronFromOptions(options);
  }

  return null;
}

export function buildCustomCronFromOptions(options) {
  var interval = parseInt(options.customInterval, 10) || 1;
  var unit = options.customUnit || "week";
  var h = options.hour;
  var m = options.minute;

  if (unit === "minute") {
    return interval === 1 ? "*/1 * * * *" : buildOffsetList(m, interval, 60) + " * * * *";
  }
  if (unit === "hour") {
    return interval === 1 ? m + " */1 * * *" : m + " " + buildOffsetList(h, interval, 24) + " * * *";
  }
  if (unit === "day") {
    if (interval === 1) return m + " " + h + " * * *";
    return m + " " + h + " */" + interval + " * *";
  }

  if (unit === "week") {
    var days = (options.customDays || []).slice();
    if (days.length === 0) days.push(String(options.selectedDate ? options.selectedDate.getDay() : 0));
    return m + " " + h + " * * " + days.sort().join(",");
  }

  if (unit === "month") {
    var dom = options.selectedDate ? options.selectedDate.getDate() : 1;
    if (interval === 1) return m + " " + h + " " + dom + " * *";
    return m + " " + h + " " + dom + " */" + interval + " *";
  }

  if (unit === "year") {
    var yearDom = options.selectedDate ? options.selectedDate.getDate() : 1;
    var month = options.selectedDate ? options.selectedDate.getMonth() + 1 : 1;
    return m + " " + h + " " + yearDom + " " + month + " *";
  }

  return null;
}

function intervalMinutesFromOptions(interval, intervalCustom) {
  if (!interval || interval === "none") return 0;
  if (interval === "custom" && intervalCustom) {
    return intervalCustom.unit === "hour" ? intervalCustom.value * 60 : intervalCustom.value;
  }
  return parseInt(interval, 10) || 0;
}
