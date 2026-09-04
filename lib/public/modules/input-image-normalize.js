var INPUT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
var INPUT_IMAGE_MAX_DIMENSION = 1920;

function normalizedDimension(value) {
  var number = Number(value);
  if (!isFinite(number) || number <= 0) return 0;
  return Math.max(1, Math.round(number));
}

export function imageResizePlan(width, height, estimatedBytes) {
  var sourceWidth = normalizedDimension(width);
  var sourceHeight = normalizedDimension(height);
  var bytes = Number(estimatedBytes) || 0;
  if (!sourceWidth || !sourceHeight) {
    return { resize: false, lossy: false, width: sourceWidth, height: sourceHeight };
  }
  var longest = Math.max(sourceWidth, sourceHeight);
  var dimensionExceeded = longest > INPUT_IMAGE_MAX_DIMENSION;
  var byteLimitExceeded = bytes > INPUT_IMAGE_MAX_BYTES;
  var scale = dimensionExceeded ? INPUT_IMAGE_MAX_DIMENSION / longest : 1;
  return {
    resize: dimensionExceeded || byteLimitExceeded,
    lossy: byteLimitExceeded,
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}
