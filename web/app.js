"use strict";
const REQUIRED = 4;
const $ = (id) => document.getElementById(id);
const video = $("camera");
let stream = null;
let photos = Array(REQUIRED).fill(null);
let busy = false;
let connecting = false;
let countdown = false;
let generation = 0;
let printPending = false;
let printUrl = null;
let cameraDevices = [];
let activeFacing = null;
let preferredFacing = "user";
let mirrorCustomized = false;
let sessionDate = new Date().toLocaleDateString();
let previewGeneration = 0;
let shareStripFile = null;
let shareCapability = null;
let replacementSlot = null;
let flowStep = "design";
const facingByDevice = new Map();
const unavailableFacing = new Set();
const mobileDevice = () => navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const facingSupported = () => Boolean(navigator.mediaDevices?.getSupportedConstraints?.().facingMode);
const requiredIndices = () => $("strip-template").value === "polaroid" ? [Number($("polaroid-photo").value)] : [0, 1, 2, 3];
const complete = () => requiredIndices().every(index => Boolean(photos[index]));
const nextSlot = () => requiredIndices().find(index => !photos[index]);
const requiredMessage = () => `Fill ${requiredIndices().length === 1 ? "the selected Polaroid photo slot" : "all four photo slots"} before saving or printing.`;
const cameraReady = () => stream?.getVideoTracks().some(track => track.readyState === "live" && !track.muted) && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0;
const status = (text) => { $("status").textContent = text; };
let cameraPreviewFrame = null;
let lastPreviewTime = 0;
let photoPreviewGeneration = 0;
const selectedFilter = () => $("strip-filter").value;

function drawCameraPreview() {
  if (!cameraReady()) return;
  const preview = $("camera-preview");
  const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
  const width = Math.round(video.videoWidth * scale), height = Math.round(video.videoHeight * scale);
  if (preview.width !== width || preview.height !== height) {
    preview.width = width; preview.height = height;
  }
  const context = preview.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, 0, 0, preview.width, preview.height);
  PhotoBoothFilters.apply(context, preview.width, preview.height, selectedFilter());
  preview.hidden = false;
}
function startCameraPreview() {
  if (cameraPreviewFrame !== null || !stream) return;
  function frame(time) {
    cameraPreviewFrame = null;
    if (!stream) return;
    try {
      // Bound preview work for phone cameras; captures retain native resolution.
      if (time - lastPreviewTime >= 1000 / 15) { drawCameraPreview(); lastPreviewTime = time; }
    } catch {
      stopCamera();
      cameraError("The filtered camera preview could not render. Choose Open camera to retry, or upload images.");
      return;
    }
    cameraPreviewFrame = requestAnimationFrame(frame);
  }
  cameraPreviewFrame = requestAnimationFrame(frame);
}
async function renderPhotoPreviews() {
  const request = ++photoPreviewGeneration;
  const filter = selectedFilter();
  await Promise.all(photos.map(async (photo, index) => {
    if (!photo) return;
    const image = await createImageBitmap(photo.blob);
    try {
      if (request !== photoPreviewGeneration || photos[index] !== photo) return;
      const target = document.querySelector(`[data-photo-index="${index}"]`);
      if (!target) return;
      const scale = Math.min(1, 480 / Math.max(image.width, image.height));
      const canvas = PhotoBoothFilters.draw(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)), filter);
      target.width = canvas.width; target.height = canvas.height;
      target.getContext("2d").drawImage(canvas, 0, 0);
      target.setAttribute("aria-label", `Photo ${index + 1}, ${PhotoBoothFilters.names[filter]} filter`);
    } finally { image.close(); }
  })).catch(() => status("A photo preview could not update. Change the filter to try again; your photos are still available."));
}
function updateFilterViews() {
  const name = PhotoBoothFilters.names[selectedFilter()];
  $("selected-filter").textContent = `Selected filter: ${name}`;
  $("camera-preview").setAttribute("aria-label", `Live camera, ${name} filter`);
  drawCameraPreview();
  renderPhotoPreviews();
}
const shareApiAvailable = () => window.isSecureContext && mobileDevice() && typeof navigator.share === "function" && typeof navigator.canShare === "function";
function canShareImage(file) {
  try { return shareApiAvailable() && navigator.canShare({ files: [file] }); }
  catch { return false; }
}
function galleryInstructions() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios
    ? "Open the downloaded PNG in Files → Downloads. Tap Share, then Save Image or Save to Photos if offered. The available actions depend on your iOS version and app."
    : "Open the PNG in your file manager’s Downloads folder. If it isn’t visible in Gallery or Google Photos, copy it to Pictures using your file manager, then reopen your gallery. Gallery visibility depends on your device and app.";
}
function showGalleryHelp() {
  if (mobileDevice()) {
    $("gallery-help").hidden = false;
    $("gallery-help").open = true;
  }
}
function cameraError(message) {
  $("camera-error-message").textContent = message;
  $("camera-error").hidden = false;
  status(`${message} You can use Upload images instead.`);
}

// Reuse the original preview and photo controls across the separate screens.
function showStep(step) {
  if (busy || connecting || countdown) return;
  if (["preview", "keep"].includes(step) && !complete()) return;
  flowStep = step;
  document.querySelector("main").dataset.step = step;
  for (const name of ["design", "camera", "preview", "keep"]) $(name + "-step").hidden = name !== step;
  const previewHost = step === "keep" ? "keep-preview-host" : step === "preview" ? "review-preview-host" : "design-preview-host";
  $(previewHost).append($("shared-strip-preview"));
  $(step === "preview" ? "review-session-host" : "camera-session-host").append(document.querySelector(".session-panel"));
  const heading = $(step + "-step").querySelector("h2");
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
  updateControls();
}

function updateControls() {
  const unlocked = !busy && !connecting && !countdown;
  for (const id of ["continue-camera", "back-design", "preview-back-camera", "back-preview", "retake-photos"]) $(id).disabled = !unlocked;
  for (const id of ["review-photos", "continue-keep"]) $(id).disabled = !complete() || !unlocked;
  $("save").disabled = !complete() || !unlocked;
  $("save-strip").disabled = !complete() || !unlocked;
  const showShare = shareApiAvailable() && shareCapability !== false;
  $("share-strip").hidden = !showShare;
  $("share-help").hidden = !showShare;
  $("download-fallback").hidden = !mobileDevice() || showShare;
  $("gallery-help").hidden = !mobileDevice();
  $("gallery-instructions").textContent = galleryInstructions();
  $("share-strip").disabled = !complete() || !unlocked || !shareStripFile || shareCapability !== true;
  $("save-folder").hidden = typeof window.showDirectoryPicker !== "function" || !window.isSecureContext;
  $("save-folder").disabled = !complete() || !unlocked;
  $("print").disabled = !complete() || !unlocked;
  $("capture").disabled = !cameraReady() || complete() || !unlocked;
  $("upload").disabled = complete() || !unlocked;
  $("image-files").disabled = complete() || !unlocked;
  $("connect").disabled = !unlocked;
  $("device").disabled = !unlocked;
  $("reset").disabled = !unlocked;
  $("mirror").disabled = !unlocked;
  $("capture-delay").disabled = !unlocked;
  document.querySelectorAll("#design-controls input, #design-controls select, #design-controls button").forEach(control => { control.disabled = !unlocked; });
  const nextFacing = (activeFacing || preferredFacing) === "environment" ? "user" : "environment";
  const labeledPair = [...facingByDevice.values()].includes("user") && [...facingByDevice.values()].includes("environment");
  const canFlip = labeledPair || (facingSupported() && (mobileDevice() || (activeFacing && cameraDevices.length > 1)));
  $("switch-camera").hidden = !stream || !canFlip || unavailableFacing.has(nextFacing);
  $("switch-camera").disabled = !unlocked || !cameraReady();
  $("switch-camera").textContent = `Switch to ${nextFacing === "user" ? "front" : "back"} camera`;
  const indices = requiredIndices(), single = indices.length === 1, next = nextSlot();
  const delay = Number($("capture-delay").value);
  $("capture").textContent = complete() ? (single ? "Your Polaroid photo is ready" : "All four photos captured") : `Capture photo ${next + 1}${delay ? ` · ${delay} second countdown` : " · no countdown"}`;
  $("progress").textContent = `${indices.filter(index => photos[index]).length} of ${indices.length} ${single ? "photo" : "photos"} ready`;
  $("session-heading").textContent = single ? "Your Polaroid photo" : "Four little moments";
  $("session-help").textContent = single ? "The selected photo is used in your Polaroid. Other session photos are preserved; choose a different photo in the customization controls." : "Capture or upload all four photos to save or print. Clear a slot to replace its photo.";
  $("template-help").textContent = single ? "One selected photo completes your Polaroid. Switch back to a four-photo template to use your other photos." : "Fill all four slots to export. Your photos stay here when you switch templates.";
  $("polaroid-photo-label").hidden = !single;
  document.querySelectorAll(".slot").forEach((slot, index) => { slot.dataset.active = String(indices.includes(index)); });
  document.querySelectorAll(".slot button").forEach(button => {
    const photo = photos[Number(button.dataset.index)];
    button.disabled = !unlocked || (button.classList.contains("retake-photo") ? !cameraReady() : button.classList.contains("clear-photo") ? !photo : false);
  });
}

function renderSlots() {
  $("slots").replaceChildren();
  photos.forEach((photo, index) => {
    const row = document.createElement("div");
    row.className = "slot";
    const preview = document.createElement("div");
    preview.className = "slot-preview";
    if (photo) {
      const image = document.createElement("canvas");
      image.dataset.photoIndex = index;
      image.setAttribute("role", "img");
      image.setAttribute("aria-label", `${photo.source === "upload" ? "Uploaded" : "Captured"} photo ${index + 1}`);
      preview.append(image);
    } else preview.textContent = `${String(index + 1).padStart(2, "0")}  ·  Waiting for photo`;
    const clear = document.createElement("button");
    clear.textContent = "×";
    clear.className = "clear-photo";
    clear.dataset.index = index;
    clear.title = `Clear photo ${index + 1}`;
    clear.setAttribute("aria-label", `Clear photo ${index + 1}`);
    clear.addEventListener("click", () => {
      if (busy || countdown || connecting) return;
      URL.revokeObjectURL(photos[index].url);
      photos[index] = null;
      invalidatePrint();
      renderSlots();
      if (!complete() && flowStep === "preview") showStep("camera");
      status(`Photo ${index + 1} cleared. Capture or upload a replacement to enable saving and printing.`);
    });
    const retake = document.createElement("button");
    retake.type = "button"; retake.className = "retake-photo"; retake.dataset.index = index;
    retake.textContent = photo ? "Retake" : "Capture";
    retake.setAttribute("aria-label", `${photo ? "Retake" : "Capture"} photo ${index + 1}`);
    retake.title = "Open the camera to capture or retake this photo";
    retake.addEventListener("click", () => { showStep("camera"); capturePhoto(index); });
    const replace = document.createElement("button");
    replace.type = "button"; replace.className = "replace-photo"; replace.dataset.index = index;
    replace.textContent = photo ? "Replace" : "Upload";
    replace.setAttribute("aria-label", `${photo ? "Replace" : "Upload"} photo ${index + 1} with an image`);
    replace.addEventListener("click", () => {
      if (busy || countdown || connecting) return;
      replacementSlot = index; $("image-files").multiple = false; $("image-files").click();
    });
    const actions = document.createElement("div"); actions.className = "slot-actions";
    actions.append(retake, replace, clear);
    row.append(preview, actions);
    $("slots").append(row);
  });
  updateControls();
  renderPhotoPreviews();
  renderStripPreview();
}

function stopCamera() {
  if (cameraPreviewFrame !== null) cancelAnimationFrame(cameraPreviewFrame);
  cameraPreviewFrame = null;
  $("camera-preview").hidden = true;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  $("placeholder").hidden = false;
  $("live-badge").hidden = true;
  updateControls();
}

async function listDevices() {
  const selected = stream?.getVideoTracks()[0]?.getSettings().deviceId || $("device").value;
  const devices = await navigator.mediaDevices.enumerateDevices();
  cameraDevices = devices.filter(device => device.kind === "videoinput");
  // Device labels are only a fallback; track settings provide the actual facing mode.
  for (const id of facingByDevice.keys()) {
    if (!cameraDevices.some(device => device.deviceId === id)) facingByDevice.delete(id);
  }
  $("device").replaceChildren(new Option("Default camera", ""));
  cameraDevices.forEach((device, index) => {
    if (/\b(back|rear|environment)\b/i.test(device.label)) facingByDevice.set(device.deviceId, "environment");
    else if (/\b(front|user|facetime)\b/i.test(device.label)) facingByDevice.set(device.deviceId, "user");
    $("device").add(new Option(device.label || `Camera ${index + 1}`, device.deviceId));
  });
  const settings = stream?.getVideoTracks()[0]?.getSettings();
  if (settings?.deviceId && settings.facingMode) facingByDevice.set(settings.deviceId, settings.facingMode);
  if ([...$("device").options].some(option => option.value === selected)) $("device").value = selected;
  updateControls();
}

function waitForVideo() {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    const check = () => {
      if (cameraReady()) resolve();
      else if (performance.now() >= deadline || !stream) reject(new Error("The camera opened but did not deliver a video frame. Reconnect it or try another camera."));
      else setTimeout(check, 50);
    };
    check();
  });
}

function cameraConstraints({ deviceId, facingMode, exactFacing = false } = {}) {
  const constraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  else if (facingMode && facingSupported()) constraints.facingMode = exactFacing ? { exact: facingMode } : { ideal: facingMode };
  return { audio: false, video: constraints };
}

async function attachCamera(acquired, request, requestedFacing = null) {
  if (request !== generation) { acquired.getTracks().forEach(track => track.stop()); return false; }
  stream = acquired;
  const settings = stream.getVideoTracks()[0].getSettings();
  const reportedFacing = settings.facingMode || facingByDevice.get(settings.deviceId);
  if (requestedFacing && reportedFacing && reportedFacing !== requestedFacing) {
    stopCamera();
    throw new DOMException("This camera does not face the requested direction.", "OverconstrainedError");
  }
  activeFacing = reportedFacing || requestedFacing || null;
  if (activeFacing) preferredFacing = activeFacing;
  if (!mirrorCustomized && activeFacing) $("mirror").checked = activeFacing === "user";
  video.classList.toggle("mirrored", $("mirror").checked);
  video.srcObject = stream;
  await video.play();
  await waitForVideo();
  $("placeholder").hidden = true;
  $("live-badge").hidden = false;
  acquired.getVideoTracks().forEach(track => {
    track.addEventListener("ended", () => {
      if (stream !== acquired) return;
      stopCamera();
      cameraError("Camera disconnected. Check the connection, then choose Open camera to try again.");
    });
    track.addEventListener("mute", updateControls);
    track.addEventListener("unmute", updateControls);
  });
  try { await listDevices(); } catch { /* Device labels are optional; capture still works. */ }
  return true;
}

async function connectCamera(options = {}) {
  if (busy || countdown || connecting) return;
  if (!window.isSecureContext) {
    cameraError("Camera access requires a secure page. Use HTTP localhost during development or HTTPS with a trusted certificate when deployed. A plain HTTP network address cannot access the camera.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError("This browser does not support camera access. Open the booth in a current version of Chrome, Edge, Firefox, or Safari.");
    return;
  }
  connecting = true;
  $("camera-error").hidden = true;
  const request = ++generation;
  const previous = stream?.getVideoTracks()[0]?.getSettings();
  const previousFacing = activeFacing;
  const requestedFacing = options.facingMode || null;
  const labeledDevice = requestedFacing && cameraDevices.find(device => facingByDevice.get(device.deviceId) === requestedFacing);
  const deviceId = requestedFacing ? (!facingSupported() ? labeledDevice?.deviceId : null) : $("device").value;
  const selection = { deviceId, facingMode: requestedFacing || preferredFacing, exactFacing: Boolean(requestedFacing) };
  stopCamera();
  status(requestedFacing ? `Switching to the ${requestedFacing === "user" ? "front" : "back"} camera…` : "Waiting for camera access. Choose Allow in your browser's permission prompt.");
  updateControls();
  try {
    // This is the actual browser camera API. No simulated preview or fallback image.
    // Release the old tracks before requesting another camera (needed on phones).
    let acquired;
    try {
      acquired = await navigator.mediaDevices.getUserMedia(cameraConstraints(selection));
    } catch (error) {
      if (!requestedFacing || !labeledDevice || !["OverconstrainedError", "NotFoundError"].includes(error.name)) throw error;
      acquired = await navigator.mediaDevices.getUserMedia(cameraConstraints({ deviceId: labeledDevice.deviceId }));
    }
    if (!await attachCamera(acquired, request, requestedFacing)) return;
    const facingLabel = activeFacing ? ` · ${activeFacing === "user" ? "Front" : "Back"} camera` : "";
    status(`Camera connected${facingLabel} · ${video.videoWidth} × ${video.videoHeight}. Ready to capture.`);
  } catch (error) {
    stopCamera();
    if (requestedFacing && ["OverconstrainedError", "NotFoundError"].includes(error.name)) {
      unavailableFacing.add(requestedFacing);
      if (previous && request === generation) {
        try {
          const restored = await navigator.mediaDevices.getUserMedia(cameraConstraints({ deviceId: previous.deviceId, facingMode: previousFacing || preferredFacing }));
          if (await attachCamera(restored, request)) {
            status(`No ${requestedFacing === "user" ? "front" : "back"} camera is available. Your previous camera is still connected.`);
            return;
          }
        } catch { stopCamera(); }
      }
    }
    const messages = {
      NotAllowedError: "Camera access was denied. Allow camera access in your browser's site settings, then choose Open camera to try again.",
      SecurityError: "Your browser has blocked camera access. Check its site permissions or open the booth in another browser.",
      NotFoundError: "No camera was found. Connect a webcam or use a device with a camera, then choose Open camera.",
      NotReadableError: "The camera is unavailable or in use. Close other camera apps and check camera permissions in your device settings, then choose Open camera.",
      AbortError: "The camera could not start. Check its connection and choose Open camera to try again.",
      OverconstrainedError: "The selected camera is unavailable. Select Default camera, then choose Open camera again."
    };
    cameraError(messages[error.name] || error.message || "Could not start the camera. Choose Open camera to try again.");
  } finally {
    connecting = false;
    updateControls();
  }
}

async function switchCamera() {
  if (busy || countdown || connecting || !stream || $("switch-camera").hidden) return;
  const facingMode = (activeFacing || preferredFacing) === "environment" ? "user" : "environment";
  await connectCamera({ facingMode });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode the captured photo.")), "image/png"));

async function capturePhoto(target = null) {
  const slot = target === null ? nextSlot() : target;
  if (busy || countdown || connecting || !Number.isInteger(slot) || slot < 0 || slot >= REQUIRED || !cameraReady()) return;
  const delay = Number($("capture-delay").value);
  const retaking = Boolean(photos[slot]);
  countdown = true;
  updateControls();
  $("capture-note").textContent = `${retaking ? "Retaking" : "Capturing"} photo ${slot + 1}`;
  $("capture-note").hidden = delay === 0;
  if (retaking) document.querySelector(".viewfinder").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  status("Look at the camera…");
  try {
    for (let remaining = delay; remaining > 0; remaining--) {
      $("countdown").textContent = remaining;
      $("countdown").hidden = false;
      await sleep(1000);
      if (!cameraReady()) throw new Error("Camera feed was interrupted. Reconnect the camera and try again.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if ($("mirror").checked) { context.translate(canvas.width, 0); context.scale(-1, 1); }
    // Capture the current real video frame at the camera's native resolution.
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas);
    const previous = photos[slot];
    photos[slot] = { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, source: "camera" };
    if (previous) URL.revokeObjectURL(previous.url);
    const flash = $("shutter-flash");
    flash.classList.remove("active"); void flash.offsetWidth; flash.classList.add("active");
    setTimeout(() => flash.classList.remove("active"), 300);
    invalidatePrint();
    status(complete() ? "Your template is complete. Review your photos, then continue to save or print." : `Photo ${slot + 1} captured. Get ready for the next one.`);
  } catch (error) { status(error.message); }
  finally {
    countdown = false;
    $("countdown").hidden = true;
    $("capture-note").hidden = true;
    renderSlots();
    if (complete() && flowStep === "camera") showStep("preview");
  }
}

async function uploadImages(fileList, replaceIndex = null) {
  const replacing = Number.isInteger(replaceIndex) && replaceIndex >= 0 && replaceIndex < REQUIRED;
  if (busy || countdown || connecting || (!replacing && complete())) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  busy = true;
  updateControls();
  status("Adding your images to the empty photo slots…");
  let added = 0, excess = 0;
  const errors = [];
  try {
    for (const file of files) {
      if (replacing ? added > 0 : complete()) { excess++; continue; }
      let image, inputUrl;
      try {
        if (file.type && !file.type.startsWith("image/")) throw new Error("Choose an image file such as JPEG, PNG, or WebP.");
        if (file.size > 20 * 1024 * 1024) throw new Error("This image exceeds 20 MB. Choose a smaller image.");
        inputUrl = URL.createObjectURL(file);
        image = new Image();
        image.src = inputUrl;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("This image is empty or damaged.");
        // Normalize browser-readable images, including their displayed orientation,
        // to PNG. Large uploads are resized to keep mobile memory use manageable.
        const scale = Math.min(1, 4096 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await toBlob(canvas);
        const slot = replacing ? replaceIndex : nextSlot();
        const previous = photos[slot];
        photos[slot] = { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, source: "upload" };
        if (previous) URL.revokeObjectURL(previous.url);
        added++;
      } catch (error) {
        const message = error.name === "EncodingError" ? "This image format cannot be opened. Try JPEG, PNG, or WebP." : error.message;
        errors.push(`${file.name}: ${message}`);
      } finally {
        if (inputUrl) URL.revokeObjectURL(inputUrl);
      }
    }
    if (added) invalidatePrint();
    const messages = [added ? `Added ${added} image${added === 1 ? "" : "s"}. ${complete() ? "Your template is ready to preview." : "Capture or upload more to finish your set."}` : "No images were added."];
    if (excess) messages.push(`${excess} extra image${excess === 1 ? " was" : "s were"} skipped because the required slots are filled.`);
    if (errors.length) messages.push(errors.join(" "));
    status(messages.join(" "));
  } finally {
    busy = false;
    $("image-files").value = "";
    $("image-files").multiple = true;
    renderSlots();
    if (complete() && flowStep === "camera") showStep("preview");
  }
}

function invalidatePrint() {
  if (printUrl) URL.revokeObjectURL(printUrl);
  printUrl = null;
  $("print-image").removeAttribute("src");
}

function stripStyle() {
  return { filter: $("strip-filter").value, template: $("strip-template").value, frameColor: $("frame-color").value, theme: $("strip-theme").value, photoIndex: Number($("polaroid-photo").value), date: sessionDate };
}

let stripExportCache = null;
async function prepareStripExport() {
  if (!complete()) throw new Error(requiredMessage());
  const style = stripStyle();
  const key = JSON.stringify({ style, photos: photos.map(photo => photo?.url || null) });
  if (!stripExportCache || stripExportCache.key !== key) {
    const blobs = photos.map(photo => photo?.blob || null);
    const promise = (async () => {
      const canvas = await PhotoBoothStrip.render(blobs, style);
      return { png: await PhotoBoothFiles.pngWithDpi(await toBlob(canvas), 300), width: canvas.width, height: canvas.height, style };
    })();
    stripExportCache = { key, promise };
  }
  const cache = stripExportCache;
  try { return await cache.promise; }
  catch (error) {
    if (stripExportCache === cache) stripExportCache = null;
    throw error;
  }
}

function syncFullFramePreview() {
  const source = $("strip-preview"), target = $("full-frame-preview");
  target.width = source.width; target.height = source.height;
  target.getContext("2d").drawImage(source, 0, 0);
}
$("open-strip-preview").addEventListener("click", () => {
  syncFullFramePreview();
  $("frame-preview-dialog").showModal();
  document.body.classList.add("preview-open");
});
$("close-strip-preview").addEventListener("click", () => $("frame-preview-dialog").close());
$("frame-preview-dialog").addEventListener("close", () => document.body.classList.remove("preview-open"));
$("frame-preview-dialog").addEventListener("click", event => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
});

async function renderStripPreview() {
  const request = ++previewGeneration;
  shareStripFile = null;
  updateControls();
  try {
    const filled = complete();
    const canvas = await PhotoBoothStrip.render(photos.map(photo => photo?.blob || null), stripStyle());
    if (request !== previewGeneration) return;
    const preview = $("strip-preview");
    preview.width = canvas.width; preview.height = canvas.height;
    preview.getContext("2d").drawImage(canvas, 0, 0);
    if ($("frame-preview-dialog").open) syncFullFramePreview();
    $("strip-resolution").textContent = `${canvas.width} × ${canvas.height} · 300 dpi`;
    if (shareApiAvailable()) {
      // Prepare the full PNG before the Share click, preserving transient user
      // activation on browsers that reject sharing after async image rendering.
      const png = await PhotoBoothFiles.pngWithDpi(await toBlob(canvas), 300);
      const file = new File([png], `${PhotoBoothFiles.sessionName()}_strip.png`, { type: "image/png" });
      if (request !== previewGeneration) return;
      shareCapability = canShareImage(file);
      shareStripFile = filled && shareCapability ? file : null;
    } else shareCapability = null;
    updateControls();
  } catch {
    if (request === previewGeneration) status("The strip preview could not update. Change a design option to try again.");
  }
}

async function sharePhotoStrip() {
  if (busy || countdown || connecting || !complete()) return;
  const file = shareStripFile;
  if (!file || !canShareImage(file)) {
    status("Image sharing is not available here. Choose Save photo strip to download the PNG instead.");
    showGalleryHelp();
    return;
  }
  busy = true;
  updateControls();
  status("Choose an available saving or sharing destination in your device’s share sheet.");
  try {
    // No awaits precede this call: the native sheet opens directly from the click.
    await navigator.share({ files: [file] });
    status("Share sheet completed. Check your chosen destination for the image.");
  } catch (error) {
    if (error.name === "AbortError") status("Sharing cancelled or no destination was available. Your photos are still here; Save photo strip downloads the PNG.");
    else {
      status("The image could not be shared. Choose Save photo strip to download the PNG instead. Your photos are still available.");
      showGalleryHelp();
    }
  } finally {
    busy = false;
    updateControls();
  }
}

async function makeLayout() {
  if (!complete()) throw new Error(requiredMessage());
  return toBlob(await PhotoBoothStrip.render(photos.map(photo => photo?.blob || null), stripStyle(), true));
}

async function savePhotoStrip() {
  if (busy || countdown || connecting || !complete()) return;
  busy = true; updateControls(); status("Preparing your high-resolution photo strip…");
  try {
    const { png, width, height } = await prepareStripExport();
    const name = `${PhotoBoothFiles.sessionName()}_strip.png`;
    PhotoBoothFiles.download(png, name);
    showGalleryHelp();
    status(`Photo strip download started · ${width} × ${height}, 300 dpi. Check your browser's Downloads folder or the save location you chose. All selected styling is included.`);
    $("save-location").textContent = `Download: ${name}`;
  } catch (error) { status(`Could not save the strip: ${error.message}. Your photos are still available.`); }
  finally { busy = false; updateControls(); }
}

async function localFiles() {
  if (!complete()) throw new Error(requiredMessage());
  const filter = selectedFilter();
  const files = await Promise.all(photos.map(async (photo, index) => {
    if (!photo) return null;
    let blob = photo.blob;
    if (filter !== "original") {
      const image = await createImageBitmap(blob);
      try { blob = await toBlob(PhotoBoothFilters.draw(image, image.width, image.height, filter)); }
      finally { image.close(); }
    }
    return { name: `photo_${String(index + 1).padStart(2, "0")}.png`, blob };
  }));
  files.push({ name: "print_6x4.png", blob: await PhotoBoothFiles.pngWithDpi(await makeLayout(), 300) });
  return files.filter(Boolean);
}

async function savePhotos({ folder = false } = {}) {
  if (busy || countdown || connecting || !complete()) return;
  busy = true; updateControls(); status("Saving your photos locally…");
  try {
    // Ask for the folder immediately, while the Save click still has activation.
    const directory = folder && typeof window.showDirectoryPicker === "function"
      ? await window.showDirectoryPicker({ id: "photobooth", mode: "readwrite", startIn: "pictures" }) : null;
    const name = PhotoBoothFiles.sessionName();
    const files = await localFiles();
    if (directory) {
      const path = await PhotoBoothFiles.writeToFolder(directory, files, name);
      status(`Saved ${files.length - 1} session photo(s) and the print layout to ${path}.`);
      $("save-location").textContent = `Last saved: ${path}`;
    } else {
      PhotoBoothFiles.download(await PhotoBoothFiles.makeZip(files), `${name}.zip`);
      status(`Your photo set download has started. Check Downloads for the ZIP containing ${files.length - 1} session photo(s) and the print layout.`);
      $("save-location").textContent = `Download: ${name}.zip`;
    }
  } catch (error) {
    if (error.name === "AbortError") status("Saving cancelled. Your photos are still available.");
    else if (error.name === "NotAllowedError" || error.name === "SecurityError") status("Folder access was not allowed. Use Download photo set to save a ZIP instead. Your photos are still available.");
    else status(`Save failed: ${error.message}. Your photos are still available.`);
  }
  finally { busy = false; updateControls(); }
}

async function printPhotos() {
  if (busy || countdown || connecting || !complete()) return;
  busy = true; updateControls();
  try {
    const { png, style } = await prepareStripExport();
    invalidatePrint(); printUrl = URL.createObjectURL(png);
    $("print-area").dataset.template = style.template;
    $("print-image").src = printUrl;
    await $("print-image").decode();
    printPending = true;
    status("Choose a printer or Save as PDF. Use portrait paper and fit to page; disable browser headers and footers. Your finished strip includes all selected styling.");
    window.print();
  } catch (error) {
    printPending = false;
    status(`Could not open printing: ${error.message}. Your photos are still available. Save photo strip to print the PNG from another app.`);
  }
  finally {
    // Browsers may return before their print dialog closes. afterprint releases the gate.
    if (!printPending) { busy = false; updateControls(); }
  }
}

$("continue-camera").addEventListener("click", () => showStep("camera"));
$("back-design").addEventListener("click", () => showStep("design"));
$("review-photos").addEventListener("click", () => showStep("preview"));
$("preview-back-camera").addEventListener("click", () => showStep("camera"));
$("continue-keep").addEventListener("click", () => showStep("keep"));
$("back-preview").addEventListener("click", () => showStep("preview"));
$("retake-photos").addEventListener("click", () => {
  if (busy || countdown || connecting) return;
  for (const index of requiredIndices()) {
    if (photos[index]) URL.revokeObjectURL(photos[index].url);
    photos[index] = null;
  }
  invalidatePrint(); renderSlots(); showStep("camera");
  status("Ready to retake your photos. Capture or upload your new moments.");
});

$("connect").addEventListener("click", () => connectCamera());
$("device").addEventListener("change", () => {
  if (stream) connectCamera();
  else status("Camera selected. Choose Open camera to request access, or Upload images to use your own photos.");
});
$("switch-camera").addEventListener("click", switchCamera);
$("capture").addEventListener("click", () => capturePhoto());
$("capture-delay").addEventListener("change", updateControls);
$("upload").addEventListener("click", () => {
  if (!busy && !countdown && !connecting && !complete()) {
    replacementSlot = null; $("image-files").multiple = true; $("image-files").click();
  }
});
$("image-files").addEventListener("change", (event) => {
  const target = replacementSlot; replacementSlot = null; uploadImages(event.target.files, target);
});
$("image-files").addEventListener("cancel", () => { replacementSlot = null; $("image-files").multiple = true; status("Image selection cancelled. Your photos are unchanged."); });
$("save").addEventListener("click", () => savePhotos());
$("save-strip").addEventListener("click", savePhotoStrip);
$("share-strip").addEventListener("click", sharePhotoStrip);
$("save-folder").addEventListener("click", () => savePhotos({ folder: true }));
$("print").addEventListener("click", printPhotos);
$("mirror").addEventListener("change", () => { mirrorCustomized = true; video.classList.toggle("mirrored", $("mirror").checked); });
let thumbnailGeneration = 0;
async function renderTemplateThumbnails() {
  const request = ++thumbnailGeneration;
  const style = stripStyle();
  for (const choice of document.querySelectorAll(".template-choice")) {
    const source = await PhotoBoothStrip.render(Array(4).fill(null), {...style, template:choice.dataset.template, photoIndex:0, filter:"original"});
    if (request !== thumbnailGeneration) return;
    const thumbnail = choice.querySelector("canvas");
    const scale = Math.min(70 / source.width, 84 / source.height);
    thumbnail.width = Math.round(source.width * scale); thumbnail.height = Math.round(source.height * scale);
    thumbnail.getContext("2d").drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
  }
}
function updateDesignSelections() {
  document.querySelectorAll(".theme-choice").forEach(choice => choice.setAttribute("aria-pressed", String(choice.dataset.theme === $("strip-theme").value)));
  document.querySelectorAll(".template-choice").forEach(choice => choice.setAttribute("aria-pressed", String(choice.dataset.template === $("strip-template").value)));
  const color = $("frame-color").value.toLowerCase();
  let name = "Custom";
  document.querySelectorAll(".color-swatch").forEach(swatch => {
    const selected = swatch.dataset.color === color;
    swatch.setAttribute("aria-pressed", String(selected));
    if (selected) name = swatch.getAttribute("aria-label");
  });
  $("color-name").textContent = `${name} · ${color.toUpperCase()}`;
  const descriptions = {none:"A quiet frame with simple keepsake typography.", sakura:"Cherry blossoms, fine branches, and delicate pink accents around your photos.", tokyo:"Japanese postcard typography, graphic borders, and a postal stamp accent.", kyoto:"Traditional wave patterns and a small seal, softly woven into the margins.", osaka:"Little city skylines and bright window accents along your frame.", hokkaido:"Delicate snowflakes and falling snow for a winter keepsake.", hanabi:"Summer firework bursts celebrating your little moments.", tsuki:"A crescent moon and tiny stars for a moonlit memory."};
  $("theme-description").textContent = descriptions[$("strip-theme").value];
}
document.querySelectorAll(".template-choice").forEach(choice => choice.addEventListener("click", () => {
  $("strip-template").value = choice.dataset.template;
  $("strip-template").dispatchEvent(new Event("input"));
}));
document.querySelectorAll(".theme-choice").forEach(choice => choice.addEventListener("click", () => {
  $("strip-theme").value = choice.dataset.theme;
  $("strip-theme").dispatchEvent(new Event("input"));
}));
document.querySelectorAll(".color-swatch").forEach(swatch => swatch.addEventListener("click", () => {
  $("frame-color").value = swatch.dataset.color;
  $("frame-color").dispatchEvent(new Event("input"));
}));
document.querySelectorAll("#design-controls input, #design-controls select").forEach(control => control.addEventListener("input", () => {
  invalidatePrint();
  if (control.id === "strip-template" && control.value === "polaroid" && !photos[Number($("polaroid-photo").value)]) {
    const first = photos.findIndex(Boolean);
    if (first >= 0) $("polaroid-photo").value = String(first);
  }
  if (control.id === "strip-filter") updateFilterViews();
  updateDesignSelections();
  updateControls();
  if (["strip-theme", "frame-color"].includes(control.id)) renderTemplateThumbnails();
  renderStripPreview();
}));
$("reset").addEventListener("click", () => {
  if (busy || countdown || connecting) return;
  photos.forEach(photo => { if (photo) URL.revokeObjectURL(photo.url); });
  replacementSlot = null; $("image-files").value = ""; $("image-files").multiple = true;
  photos = Array(REQUIRED).fill(null); sessionDate = new Date().toLocaleDateString(); invalidatePrint(); renderSlots(); showStep("design"); status("Choose your design, then continue to the camera for a new photo set.");
});
video.addEventListener("loadeddata", updateControls);
video.addEventListener("playing", () => { updateControls(); startCameraPreview(); });
window.addEventListener("beforeprint", () => {
  // Keyboard/browser printing must never output an incomplete or stale strip.
  $("print-area").dataset.ready = String(complete() && Boolean(printUrl) && $("print-image").naturalWidth > 0);
});
window.addEventListener("afterprint", () => {
  if (!printPending) return;
  printPending = false; busy = false; updateControls();
  status("Print dialog closed. Check your printer or saved PDF if you confirmed printing. Your photos remain available to save or print again.");
});
window.addEventListener("pagehide", () => { ++generation; stopCamera(); });
window.addEventListener("beforeunload", (event) => { if (photos.some(Boolean)) { event.preventDefault(); event.returnValue = ""; } });
navigator.mediaDevices?.addEventListener("devicechange", () => { unavailableFacing.clear(); listDevices().catch(() => {}); });
video.classList.toggle("mirrored", $("mirror").checked);
updateDesignSelections();
renderTemplateThumbnails();
renderSlots();

"use strict";
// Keep native selects as the app's data source; render accessible, themed menus.
(() => {
  let openMenu = null;
  document.querySelectorAll("select:not([hidden])").forEach(select => {
    const label = select.closest("label");
    const name = select.getAttribute("aria-label") || Array.from(label?.childNodes || []).filter(node => node.nodeType === 3).map(node => node.textContent).join(" ").trim() || "Choose an option";
    const wrapper = document.createElement("div"); wrapper.className = "mist-select";
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "mist-select-trigger";
    trigger.id = `${select.id}-trigger`;
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${select.id}-options`);
    if (select.getAttribute("aria-describedby")) trigger.setAttribute("aria-describedby", select.getAttribute("aria-describedby"));
    const menu = document.createElement("div"); menu.className = "mist-options"; menu.id = `${select.id}-options`; menu.hidden = true;
    menu.setAttribute("role", "listbox"); menu.setAttribute("aria-label", name);
    select.before(wrapper); wrapper.append(select, trigger, menu); select.hidden = true;
    if (label) label.htmlFor = trigger.id;
    let active = 0, typed = "", typedTimer;
    const enabled = () => Array.from(select.options).map((option,index) => ({option,index})).filter(item => !item.option.disabled);
    function highlight(index) {
      active = index;
      Array.from(menu.children).forEach((item,i) => item.classList.toggle("is-active", i === active));
      const item = menu.children[active];
      if (item) { trigger.setAttribute("aria-activedescendant", item.id); if (!menu.hidden) item.scrollIntoView({block:"nearest"}); }
    }
    function close() {
      menu.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
      if (openMenu === close) openMenu = null;
    }
    function sync() {
      trigger.textContent = select.selectedOptions[0]?.textContent || "Choose an option";
      trigger.setAttribute("aria-label", `${name}: ${trigger.textContent}`);
      trigger.disabled = select.disabled;
      if (select.disabled) close();
      menu.replaceChildren();
      Array.from(select.options).forEach((option,index) => {
        const item = document.createElement("div"); item.className = "mist-option"; item.id = `${select.id}-option-${index}`;
        item.textContent = option.textContent; item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === select.selectedIndex)); item.setAttribute("aria-disabled", String(option.disabled));
        item.addEventListener("pointermove", () => { if (!option.disabled) highlight(index); });
        item.addEventListener("pointerdown", event => event.preventDefault());
        item.addEventListener("click", event => { event.preventDefault(); choose(index); }); menu.append(item);
      });
      if (!menu.hidden) highlight(select.selectedIndex);
    }
    function choose(index) {
      if (select.disabled || !select.options[index] || select.options[index].disabled) return;
      select.selectedIndex = index;
      close(); sync(); trigger.focus({preventScroll:true});
      select.dispatchEvent(new Event("input", {bubbles:true})); select.dispatchEvent(new Event("change", {bubbles:true}));
    }
    function open() {
      if (select.disabled) return;
      if (openMenu) openMenu();
      const rect = trigger.getBoundingClientRect();
      const height = Math.min(336, innerHeight * .5, select.options.length * 44 + 14);
      wrapper.dataset.placement = innerHeight - rect.bottom < height && rect.top > innerHeight - rect.bottom ? "up" : "down";
      menu.hidden = false; trigger.setAttribute("aria-expanded", "true"); openMenu = close;
      highlight(select.selectedIndex >= 0 ? select.selectedIndex : enabled()[0]?.index || 0);
    }
    trigger.addEventListener("click", () => menu.hidden ? open() : close());
    trigger.addEventListener("keydown", event => {
      const items = enabled();
      if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
        event.preventDefault();
        if (menu.hidden) { open(); if (event.key === "ArrowDown" || event.key === "ArrowUp") return; }
        const position = items.findIndex(item => item.index === active);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0,Math.min(items.length-1,position + (event.key === "ArrowDown" ? 1 : -1)));
        if (items[next]) highlight(items[next].index);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); menu.hidden ? open() : choose(active);
      } else if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") close();
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typed += event.key.toLowerCase(); clearTimeout(typedTimer); typedTimer = setTimeout(() => { typed = ""; },500);
        const match = items.find(item => item.option.textContent.toLowerCase().startsWith(typed));
        if (match) { if (menu.hidden) open(); highlight(match.index); }
      }
    });
    document.addEventListener("pointerdown", event => { if (!wrapper.contains(event.target)) close(); });
    wrapper.addEventListener("focusout", event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    window.addEventListener("resize", close);
    select.addEventListener("input", sync); select.addEventListener("change", sync);
    new MutationObserver(sync).observe(select, {attributes:true,attributeFilter:["disabled"],childList:true,subtree:true,characterData:true});
    sync();
  });
})();
