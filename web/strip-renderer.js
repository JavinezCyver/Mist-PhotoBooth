"use strict";
(() => {
  const templates = {
    classic: { name: "Classic strip", width: 900, height: 2700, count: 4, slots: Array.from({length:4}, (_, index) => ({ x:75, y:120 + index * 570, width:750, height:540, index })) },
    grid: { name: "Four-photo grid", width: 1800, height: 1800, count: 4, slots: Array.from({length:4}, (_, index) => ({ x:120 + index % 2 * 810, y:130 + Math.floor(index / 2) * 720, width:750, height:660, index })) },
    polaroid: { name: "Single Polaroid", width: 1200, height: 1500, count: 1, slots: [{ x:100, y:90, width:1000, height:1000, index:0 }] }
  };
  function layout(template, sheet = false, photoIndex = 0) {
    const source = templates[template] || templates.classic;
    if (sheet) return {
      width:1800, height:1200,
      slots: source.count === 1 ? [{x:450,y:70,width:900,height:900,index:photoIndex}] : Array.from({length:4}, (_, index) => ({x:60 + index % 2 * 855,y:75 + Math.floor(index / 2) * 510,width:825,height:465,index}))
    };
    return { width:source.width, height:source.height, slots:source.slots.map(slot => ({ ...slot, index:source.count === 1 ? photoIndex : slot.index })) };
  }
  function roundedPath(context, x, y, width, height, radius) {
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + width, y, x + width, y + height, radius);
    context.arcTo(x + width, y + height, x, y + height, radius);
    context.arcTo(x, y + height, x, y, radius);
    context.arcTo(x, y, x + width, y, radius);
    context.closePath();
  }
  function filteredPhoto(image, width, height, filter) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    const ratio = Math.max(width / image.width, height / image.height);
    const cropWidth = width / ratio, cropHeight = height / ratio;
    context.drawImage(image, (image.width - cropWidth) / 2, (image.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, width, height);
    PhotoBoothFilters.apply(context, width, height, filter);
    return canvas;
  }
  function textColor(color) {
    function luminance(hex) {
      const values = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
    }
    const background = luminance(color);
    const ratio = hex => { const ink = luminance(hex); return (Math.max(ink, background) + .05) / (Math.min(ink, background) + .05); };
    const palette = ratio("#44313a") > ratio("#fbf5f7") ? "#44313a" : "#fbf5f7";
    // Keep palette typography when readable, with black/white for midtone custom colors.
    return ratio(palette) >= 4.5 ? palette : ratio("#000000") > ratio("#ffffff") ? "#000000" : "#ffffff";
  }
  function blossom(context, x, y, radius) {
    context.save(); context.translate(x, y);
    for (let petal = 0; petal < 5; petal++) {
      context.rotate(Math.PI * 2 / 5);
      context.beginPath(); context.ellipse(0, -radius * .55, radius * .43, radius * .65, 0, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = "#a45472"; context.beginPath(); context.arc(0, 0, radius * .17, 0, Math.PI * 2); context.fill(); context.restore();
  }
  function decorations(context, design, style, sheet) {
    const {width, height, slots} = design;
    const theme = style.theme;
    if (!theme || theme === "none" || theme === "minimal") return;
    context.save();
    // Clip decorations to frame space. Even if an accent crosses a boundary,
    // it cannot paint over any photo or Polaroid card.
    context.beginPath(); context.rect(0, 0, width, height);
    slots.forEach(slot => {
      const pad = style.template === "polaroid" ? 25 : 0;
      context.rect(slot.x - pad, slot.y - pad, slot.width + pad * 2, slot.height + (pad ? 75 : 0) + pad);
    });
    context.clip("evenodd");
    const ink = textColor(style.frameColor);
    const light = ink === "#44313a" || ink === "#000000";
    if (theme === "sakura") {
      context.strokeStyle = light ? "#bd7893" : "#efd0da"; context.lineWidth = 3;
      for (const x of [32, width - 32]) {
        context.beginPath(); context.moveTo(x, 100); context.bezierCurveTo(x + 20, height * .3, x - 15, height * .7, x, height - 160); context.stroke();
        for (let index = 0; index < 5; index++) {
          context.fillStyle = index % 2 ? "#e7a7bf" : "#fbf5f7";
          blossom(context, x + (index % 2 ? 9 : -5), 150 + index * (height - 420) / 4, 20);
        }
      }
      context.fillStyle = "#e7a7bf"; blossom(context, width - 65, height - 80, 30);
    } else if (theme === "tokyo") {
      context.strokeStyle = ink; context.lineWidth = 4; context.strokeRect(18, 18, width - 36, height - 36);
      context.lineWidth = 1; context.strokeRect(28, 28, width - 56, height - 56);
      context.fillStyle = ink;
      context.fillRect(42, 44, 14, 30); context.fillRect(64, 44, 7, 30);
      context.font = '600 28px "Yu Gothic", sans-serif'; context.textAlign = "center";
      context.fillText("東京 / TOKYO · PHOTO POSTCARD", width / 2, sheet ? 52 : 62);
      context.strokeRect(width - 125, height - 110, 65, 65);
      context.font = '22px "Yu Gothic", sans-serif'; context.fillText("〒", width - 92, height - 67);
    } else if (theme === "kyoto") {
      context.strokeStyle = ink; context.globalAlpha = .28; context.lineWidth = 2;
      // Seigaiha-inspired overlapping waves, confined to the outer margins.
      for (const x of [28, width - 28]) for (let y = 130; y < height - 120; y += 95) {
        for (const radius of [12, 23, 34]) {
          context.beginPath(); context.arc(x, y, radius, Math.PI, Math.PI * 2); context.stroke();
        }
      }
      context.globalAlpha = 1; context.fillStyle = light ? "#a45472" : "#efd0da";
      context.fillRect(width - 95, height - 115, 44, 65);
      context.fillStyle = light ? "#fbf5f7" : "#44313a"; context.font = '24px "Yu Mincho", serif'; context.textAlign = "center";
      context.fillText("京", width - 73, height - 72);
    }
    if (["osaka", "hokkaido", "hanabi", "tsuki"].includes(theme)) {
      context.strokeStyle = ink; context.fillStyle = ink; context.lineWidth = 2;
      if (theme === "osaka") {
        // Small city skylines along the side margins.
        for (const x of [14, width - 56]) for (let y = 155; y < height - 230; y += 155) {
          context.strokeRect(x, y, 16, 55); context.strokeRect(x + 22, y - 22, 18, 77);
          for (let row = 0; row < 3; row++) { context.fillRect(x + 5, y + 10 + row * 13, 5, 5); context.fillRect(x + 28, y - 10 + row * 16, 5, 5); }
        }
      } else if (theme === "hokkaido") {
        for (const x of [35, width - 35]) for (let y = 160; y < height - 220; y += 175) {
          for (let ray = 0; ray < 6; ray++) {
            const angle = ray * Math.PI / 3;
            context.beginPath(); context.moveTo(x, y); context.lineTo(x + Math.cos(angle) * 22, y + Math.sin(angle) * 22); context.stroke();
          }
          context.beginPath(); context.arc(x, y + 70, 3, 0, Math.PI * 2); context.fill();
        }
      } else if (theme === "hanabi") {
        for (const x of [35, width - 35]) for (let y = 175; y < height - 220; y += 230) {
          for (let ray = 0; ray < 12; ray++) {
            const angle = ray * Math.PI / 6;
            context.beginPath(); context.moveTo(x + Math.cos(angle) * 10, y + Math.sin(angle) * 10); context.lineTo(x + Math.cos(angle) * 28, y + Math.sin(angle) * 28); context.stroke();
          }
        }
      } else {
        // A crescent at the top, with stars down both sides.
        context.beginPath(); context.arc(width / 2, 52, 24, 0, Math.PI * 2); context.fill();
        context.fillStyle = style.frameColor; context.beginPath(); context.arc(width / 2 + 12, 43, 21, 0, Math.PI * 2); context.fill();
        context.strokeStyle = ink;
        for (const x of [35, width - 35]) for (let y = 180; y < height - 220; y += 185) {
          context.beginPath(); context.moveTo(x - 10, y); context.lineTo(x + 10, y); context.moveTo(x, y - 10); context.lineTo(x, y + 10); context.stroke();
        }
      }
    }
    if (["umi", "mori", "love", "hoshi", "ribbon", "retro"].includes(theme)) {
      context.strokeStyle = ink; context.fillStyle = ink; context.lineWidth = 3;
      for (const x of [35, width - 35]) for (let y = 165; y < height - 240; y += 180) {
        context.save(); context.translate(x, y);
        if (theme === "umi") {
          for (const offset of [-12, 0, 12]) {
            context.beginPath(); context.moveTo(-24, offset);
            context.bezierCurveTo(-12, offset - 14, 0, offset + 14, 12, offset);
            context.bezierCurveTo(18, offset - 7, 22, offset - 7, 26, offset); context.stroke();
          }
        } else if (theme === "mori") {
          context.beginPath(); context.moveTo(0, 34); context.lineTo(0, -34); context.stroke();
          for (const offset of [-20, 0, 20]) {
            context.beginPath(); context.ellipse(-10, offset, 7, 14, -.65, 0, Math.PI * 2); context.fill();
            context.beginPath(); context.ellipse(10, offset - 10, 7, 14, .65, 0, Math.PI * 2); context.fill();
          }
        } else if (theme === "love") {
          context.beginPath(); context.moveTo(0, 20);
          context.bezierCurveTo(-42, -6, -18, -32, 0, -14);
          context.bezierCurveTo(18, -32, 42, -6, 0, 20); context.closePath(); context.fill();
        } else if (theme === "hoshi") {
          context.beginPath();
          for (let point = 0; point < 10; point++) {
            const angle = -Math.PI / 2 + point * Math.PI / 5;
            const radius = point % 2 ? 10 : 24;
            const px = Math.cos(angle) * radius, py = Math.sin(angle) * radius;
            if (point === 0) context.moveTo(px, py); else context.lineTo(px, py);
          }
          context.closePath(); context.stroke();
          context.beginPath(); context.arc(0, 65, 3, 0, Math.PI * 2); context.fill();
        } else if (theme === "ribbon") {
          context.beginPath(); context.moveTo(0, 0);
          context.bezierCurveTo(-36, -36, -36, 24, 0, 0);
          context.bezierCurveTo(36, -36, 36, 24, 0, 0); context.stroke();
          context.beginPath(); context.moveTo(0, 0); context.lineTo(-14, 32);
          context.moveTo(0, 0); context.lineTo(14, 32); context.stroke();
          context.beginPath(); context.arc(0, 0, 4, 0, Math.PI * 2); context.fill();
        } else {
          for (let row = 0; row < 4; row++) for (let column = 0; column < 2; column++) {
            if ((row + column) % 2 === 0) context.fillRect(-16 + column * 16, -32 + row * 16, 16, 16);
          }
        }
        context.restore();
      }
    }
    context.restore();
  }
  async function render(photos, style, sheet = false, { maxDimension } = {}) {
    const design = layout(style.template, sheet, style.photoIndex || 0);
    // Draw tiny template thumbnails directly at their display resolution.
    // Saving and printing omit maxDimension and retain the full-size layout.
    const scale = Number.isFinite(maxDimension) && maxDimension > 0 ? Math.min(1, maxDimension / Math.max(design.width, design.height)) : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(design.width * scale)); canvas.height = Math.max(1, Math.round(design.height * scale));
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    const frameColor = /^#[0-9a-f]{6}$/i.test(style.frameColor) ? style.frameColor : "#efd0da";
    context.fillStyle = frameColor; context.fillRect(0, 0, design.width, design.height);
    for (const slot of design.slots) {
      const {x, y, width, height, index} = slot;
      if (style.template === "polaroid") {
        context.fillStyle = "#ffffff"; context.fillRect(x - 25, y - 25, width + 50, height + 100);
      }
      context.save(); roundedPath(context, x, y, width, height, 0); context.clip();
      if (photos[index]) {
        const image = await createImageBitmap(photos[index]);
        try { context.drawImage(filteredPhoto(image, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), style.filter), x, y, width, height); }
        finally { image.close(); }
      } else {
        context.fillStyle = "#fbf5f7"; context.fillRect(x, y, width, height);
        context.fillStyle = "#a45472"; context.font = "36px sans-serif"; context.textAlign = "center";
        context.fillText(`Photo ${index + 1}`, x + width / 2, y + height / 2);
      }
      context.restore();
    }
    decorations(context, design, {...style, frameColor}, sheet);
    context.fillStyle = textColor(frameColor); context.textAlign = "center";
    const footerY = sheet ? design.height - 75 : design.height - (style.template === "polaroid" ? 205 : 160);
    const themes = {
      none: { title: "Minimal ミニマル", caption: "Simply you" },
      sakura: { title: "Sakura 桜", caption: "Cherry blossom" },
      tokyo: { title: "Tokyo 東京", caption: "City postcards" },
      kyoto: { title: "Kyoto 京都", caption: "Quiet moments" },
      osaka: { title: "Osaka 大阪", caption: "City lights" },
      hokkaido: { title: "Hokkaido 北海道", caption: "Snowy memories" },
      hanabi: { title: "Hanabi 花火", caption: "Summer fireworks" },
      tsuki: { title: "Tsuki 月", caption: "Moonlit moments" },
      umi: { title: "Umi 海", caption: "Ocean breeze" },
      mori: { title: "Mori 森", caption: "Forest whispers" },
      love: { title: "Love", caption: "Sweet little hearts" },
      hoshi: { title: "Hoshi 星", caption: "Written in the stars" },
      ribbon: { title: "Ribbon", caption: "Tied with a bow" },
      retro: { title: "Retro", caption: "Good old days" }
    };
    const theme = themes[style.theme] || themes.none;
    context.font = `600 ${sheet ? 28 : 34}px Georgia, "Yu Mincho", serif`;
    context.fillText(theme.title, design.width / 2, footerY);
    context.font = `${sheet ? 22 : 26}px "Yu Gothic", sans-serif`;
    context.fillText(`${theme.caption}  /  ${style.date}`, design.width / 2, footerY + 45);
    return canvas;
  }
  globalThis.PhotoBoothStrip = { render, templates, layout };
})();
