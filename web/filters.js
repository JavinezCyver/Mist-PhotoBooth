"use strict";
(() => {
  const names = { original: "Original", bw: "Black & White", mono: "Mono", vintage: "Vintage", sepia: "Sepia", rosy: "Rosy", soft: "Soft" };
  // Every view and output uses these pixel transforms. Sources remain untouched
  // so changing a filter never compounds it with an earlier selection.
  function apply(context, width, height, filter) {
    if (filter === "original" || !names[filter]) return;
    const pixels = context.getImageData(0, 0, width, height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (filter === "bw" || filter === "mono") {
        const gray = .2126 * r + .7152 * g + .0722 * b;
        const tone = filter === "mono" ? (gray - 128) * 1.5 + 128 : gray;
        data[i] = data[i + 1] = data[i + 2] = tone;
      } else if (filter === "sepia") {
        data[i] = .393 * r + .769 * g + .189 * b;
        data[i + 1] = .349 * r + .686 * g + .168 * b;
        data[i + 2] = .272 * r + .534 * g + .131 * b;
      } else if (filter === "vintage") {
        data[i] = (r * 1.08 + 14 - 128) * .92 + 128;
        data[i + 1] = (g * 1.02 + 5 - 128) * .92 + 128;
        data[i + 2] = (b * .86 + 7 - 128) * .92 + 128;
      } else if (filter === "rosy") {
        data[i] = r * .98 + 18;
        data[i + 1] = g * .95 + 4;
        data[i + 2] = b * .98 + 12;
      } else if (filter === "soft") {
        data[i] = (r - 128) * .82 + 148;
        data[i + 1] = (g - 128) * .82 + 146;
        data[i + 2] = (b - 128) * .82 + 147;
      }
    }
    context.putImageData(pixels, 0, 0);
  }
  function draw(source, width, height, filter) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: filter !== "original" });
    context.drawImage(source, 0, 0, width, height);
    apply(context, width, height, filter);
    return canvas;
  }
  globalThis.PhotoBoothFilters = { names, apply, draw };
})();
