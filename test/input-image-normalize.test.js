var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");

async function loadPlanner() {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules",
    "input-image-normalize.js"), "utf8");
  return import("data:text/javascript;base64," + Buffer.from(source).toString("base64") +
    "#" + Date.now() + Math.random());
}

test("small-byte screenshots over 2000 pixels are downscaled before upload", async function () {
  var planner = await loadPlanner();
  assert.deepEqual(planner.imageResizePlan(2557, 961, 99225), {
    resize: true,
    lossy: false,
    width: 1920,
    height: 722,
  });
  assert.deepEqual(planner.imageResizePlan(214, 65, 4026), {
    resize: false,
    lossy: false,
    width: 214,
    height: 65,
  });
});

test("byte-heavy images are re-encoded even when dimensions already fit", async function () {
  var planner = await loadPlanner();
  assert.deepEqual(planner.imageResizePlan(1200, 800, (5 * 1024 * 1024) + 1), {
    resize: true,
    lossy: true,
    width: 1200,
    height: 800,
  });
});

test("the composer applies the dimension plan before adding a pending image", function () {
  var source = fs.readFileSync(path.join(__dirname, "..", "lib", "public", "modules", "input.js"), "utf8");
  assert.match(source, /import \{ imageResizePlan \} from '\.\/input-image-normalize\.js';/);
  assert.match(source, /imageResizePlan\(img\.naturalWidth, img\.naturalHeight, estimatedBytes\)/);
  assert.match(source, /addPendingImage\(dataUrl, resized\)/);
  assert.match(source, /image\.providerData = providerImage\.data/);
  assert.ok(source.indexOf("imageResizePlan(img.naturalWidth") <
    source.indexOf("if (!plan.resize)"));
});
