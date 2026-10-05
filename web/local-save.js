"use strict";
// Browser-local files only. This module makes no network requests.
(() => {
  const encoder = new TextEncoder();
  const table = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  function crc32(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  function safeName(name) {
    if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(name)) throw new Error("Invalid local filename.");
    return name;
  }
  function sessionName() {
    return `PhotoBooth_${new Date().toISOString().replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  }
  async function pngWithDpi(blob, dpi = 300) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error("The print layout is not a PNG image.");
    const chunk = new Uint8Array(21), view = new DataView(chunk.buffer);
    view.setUint32(0, 9);
    chunk.set(encoder.encode("pHYs"), 4);
    view.setUint32(8, Math.round(dpi / 0.0254));
    view.setUint32(12, Math.round(dpi / 0.0254));
    chunk[16] = 1;
    view.setUint32(17, crc32(chunk.subarray(4, 17)));
    const parts = [bytes.subarray(0, 8)];
    const input = new DataView(bytes.buffer);
    for (let offset = 8; offset < bytes.length;) {
      if (offset + 12 > bytes.length) throw new Error("The print layout is incomplete.");
      const end = offset + input.getUint32(offset) + 12;
      if (end > bytes.length) throw new Error("The print layout is incomplete.");
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type !== "pHYs") parts.push(bytes.subarray(offset, end));
      if (type === "IHDR") parts.push(chunk);
      offset = end;
    }
    return new Blob(parts, { type: "image/png" });
  }
  async function makeZip(files, date = new Date()) {
    const bodies = [], directory = [];
    let offset = 0;
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    for (const file of files) {
      const name = encoder.encode(safeName(file.name));
      const data = new Uint8Array(await file.blob.arrayBuffer());
      const checksum = crc32(data);
      const header = new Uint8Array(30 + name.length), local = new DataView(header.buffer);
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true);
      local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, checksum, true);
      local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, name.length, true);
      header.set(name, 30);
      const entry = new Uint8Array(46 + name.length), central = new DataView(entry.buffer);
      central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x800, true);
      central.setUint16(12, dosTime, true); central.setUint16(14, dosDate, true); central.setUint32(16, checksum, true);
      central.setUint32(20, data.length, true); central.setUint32(24, data.length, true); central.setUint16(28, name.length, true); central.setUint32(42, offset, true);
      entry.set(name, 46);
      bodies.push(header, data); directory.push(entry); offset += header.length + data.length;
    }
    const footer = new Uint8Array(22), end = new DataView(footer.buffer);
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, directory.reduce((sum, entry) => sum + entry.length, 0), true); end.setUint32(16, offset, true);
    return new Blob([...bodies, ...directory, footer], { type: "application/zip" });
  }
  async function writeToFolder(parent, files, name) {
    safeName(name);
    files.forEach(file => safeName(file.name));
    const folder = await parent.getDirectoryHandle(name, { create: true });
    for (const file of files) {
      const handle = await folder.getFileHandle(file.name, { create: true });
      const writer = await handle.createWritable();
      try {
        await writer.write(file.blob);
        await writer.close();
      } catch (error) {
        try { await writer.abort(); } catch { /* Preserve the original write error. */ }
        throw new Error(`Could not finish writing ${file.name}. Some files may already be in ${name}. ${error.message}`);
      }
    }
    return `${parent.name} / ${name}`;
  }
  function download(blob, filename) {
    safeName(filename);
    const link = document.createElement("a"), url = URL.createObjectURL(blob);
    link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  globalThis.PhotoBoothFiles = { crc32, pngWithDpi, makeZip, writeToFolder, download, sessionName };
  if (typeof module !== "undefined") module.exports = globalThis.PhotoBoothFiles;
})();
