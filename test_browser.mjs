// Uses Chrome DevTools and Node's built-in WebSocket (Node 22+).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const folder = await mkdtemp(path.join(tmpdir(), 'photobooth-browser-'));
let serverOutput = '';
let server, chrome, socket;
try {
  const serverArgs = ['server.py', '--port', '0', '--no-browser'];
  if (process.argv.includes('--deployed-origin')) {
    assert.ok(process.argv.includes('--https'), '--deployed-origin requires --https');
    const reservation = createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    serverArgs[2] = String(port);
    serverArgs.push('--public-url', `https://photobooth.test:${port}`);
  }
  let certificateFingerprint;
  if (process.argv.includes('--https')) {
    const cert = path.join(folder, 'cert.pem'), key = path.join(folder, 'key.pem');
    execFileSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:photobooth.test,IP:127.0.0.1', '-days', '1'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    const certificate = new X509Certificate(await readFile(cert));
    certificateFingerprint = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
    serverArgs.push('--cert', cert, '--key', key);
  }
  server = spawn(path.resolve('.venv/Scripts/python.exe'), serverArgs, { windowsHide: true });
  server.stdout.on('data', data => { serverOutput += data; });
  for (let i = 0; i < 100 && !/https?:\/\//.test(serverOutput); i++) await sleep(100);
  let url = serverOutput.match(/Photo Booth: (https?:\/\/[^\s]+)/)?.[1];
  if (process.argv.includes('--localhost')) url = url?.replace('127.0.0.1', 'localhost');
  assert.ok(url, 'Local server failed to start');
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${path.join(folder, 'profile')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
  if (process.argv.includes('--deployed-origin')) args.unshift('--host-resolver-rules=MAP photobooth.test 127.0.0.1', '--no-proxy-server');
  // Approve only this ephemeral test certificate's key. Production needs a
  // trusted certificate; no insecure-origin or global TLS bypass flags are used.
  if (certificateFingerprint) args.unshift(`--ignore-certificate-errors-spki-list=${certificateFingerprint}`);
  chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args, { windowsHide: true, stdio: 'ignore' });
  let debugPort;
  for (let i = 0; i < 100; i++) {
    try { debugPort = (await readFile(path.join(folder, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await sleep(100); }
  }
  assert.ok(debugPort, 'Chrome DevTools failed to start');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  let documentHeaders = {};
  const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Network.responseReceived' && message.params.type === 'Document') documentHeaders = message.params.response.headers;
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer); pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression, userGesture = false) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Network.enable');
  const downloads = path.join(folder, 'downloads');
  await mkdir(downloads);
  await command('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const checkDownloads = async expected => {
    let files = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      files = (await readdir(downloads)).filter(name => name.endsWith('.zip'));
      if (files.length === expected) break;
      await sleep(100);
    }
    assert.equal(files.length, expected, 'Photo set ZIP was not downloaded');
    execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c', `
import sys, zipfile
from io import BytesIO
from PIL import Image
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    assert sorted(archive.namelist()) == ['photo_01.png','photo_02.png','photo_03.png','photo_04.png','print_6x4.png']
    for name in archive.namelist():
        with Image.open(BytesIO(archive.read(name))) as image:
            image.load()
            assert image.format == 'PNG'
            if name == 'print_6x4.png':
                assert image.size == (1800, 1200)
                assert abs(image.info['dpi'][0] - 300) < 0.1
`, path.join(downloads, files.at(-1))], { windowsHide: true });
  };
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__cameraRequests = 0;
    window.__saveRequests = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, ...args) => { if (input === '/api/save') window.__saveRequests++; return originalFetch(input, ...args); };
    if (navigator.mediaDevices?.getUserMedia) {
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__spyGetCamera = constraints => { window.__cameraRequests++; return original(constraints); };
      navigator.mediaDevices.getUserMedia = window.__spyGetCamera;
    }
  ` });
  await command('Page.navigate', { url });
  for (let i = 0; i < 100; i++) {
    if (await evaluate('typeof connectCamera === "function" && Boolean(document.getElementById("strip-filter-trigger"))')) break;
    await sleep(100);
  }
  if (process.argv.includes('--performance-only')) {
    await command('Emulation.setCPUThrottlingRate', {rate:4});
    const metrics = await evaluate(`(async () => {
      const cards = Array.from(document.querySelectorAll('.theme-choice'));
      const times = [];
      for (let index=0; index<32; index++) {
        const start = performance.now(); cards[index % cards.length].click(); times.push(performance.now() - start);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      for (let index=0; index<32; index++) cards[index % cards.length].click();
      await new Promise(resolve => setTimeout(resolve, 500));
      const expected = await PhotoBoothStrip.render(photos.map(photo => photo?.blob || null), stripStyle());
      if (expected.toDataURL() !== document.getElementById('strip-preview').toDataURL()) throw new Error('Rapid theme clicks left a stale preview');
      if (document.querySelector('.theme-choice[aria-pressed=true]').dataset.theme !== 'tsuki') throw new Error('Final theme selection was lost');
      times.sort((a,b) => a-b);
      return {medianClickMs:times[16], p95ClickMs:times[30], maxClickMs:times[31]};
    })()`);
    assert.deepEqual(errors, []);
    console.log('Theme selection at 4x CPU slowdown:', JSON.stringify(metrics));
    console.log('PASS: rapid theme selection keeps the final frame preview and selected card in sync.');
  } else if (process.argv.includes('--flow-only')) {
    const action = (expression, gesture = false) => evaluate(`(async () => { ${expression} })()`, gesture);
    const visibleStep = () => evaluate(`Array.from(document.querySelectorAll('main > section, main > aside')).filter(panel => !panel.hidden).map(panel => panel.id)`);
    assert.deepEqual(await visibleStep(), ['design-step']);
    assert.equal(await evaluate(`(async () => {
      const original = CanvasRenderingContext2D.prototype.fillText;
      const labels = [];
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) { labels.push(text); return original.call(this, text, ...args); };
      try {
        for (const [theme, title, caption] of [["none", "Minimal ミニマル", "Simply you"], ["sakura", "Sakura 桜", "Cherry blossom"], ["tokyo", "Tokyo 東京", "City postcards"], ["kyoto", "Kyoto 京都", "Quiet moments"], ["osaka", "Osaka 大阪", "City lights"], ["hokkaido", "Hokkaido 北海道", "Snowy memories"], ["hanabi", "Hanabi 花火", "Summer fireworks"], ["tsuki", "Tsuki 月", "Moonlit moments"], ["umi", "Umi 海", "Ocean breeze"], ["mori", "Mori 森", "Forest whispers"], ["love", "Love", "Sweet little hearts"], ["hoshi", "Hoshi 星", "Written in the stars"], ["ribbon", "Ribbon", "Tied with a bow"], ["retro", "Retro", "Good old days"]]) {
          document.querySelector('[data-theme="' + theme + '"]').click();
          if (document.getElementById('strip-theme').value !== theme) return false;
          for (const template of ['classic','grid','polaroid']) {
            labels.length = 0;
            await PhotoBoothStrip.render(Array(4).fill(null), {...stripStyle(), template});
            if (!labels.includes(title) || !labels.some(label => label.startsWith(caption + '  /  ')) || labels.includes('MIST PHOTOBOOTH')) return false;
          }
        }
        return true;
      } finally { CanvasRenderingContext2D.prototype.fillText = original; }
    })()`), true, 'Theme cards must replace the frame branding with the matching title and caption for every template');
    assert.equal(await evaluate(`(async () => {
      // A uniform source must reach every corner of every photo slot, with no padding.
      for (const [width,height] of [[320,180],[180,320]]) {
        const source=document.createElement('canvas'); source.width=width; source.height=height;
        const context=source.getContext('2d'); context.fillStyle='#1248a0'; context.fillRect(0,0,width,height);
        const blob=await toBlob(source);
        for (const template of ['classic','grid','polaroid']) for (const sheet of [false,true]) {
          const canvas=await PhotoBoothStrip.render([blob,blob,blob,blob], {...stripStyle(),template,theme:'none',filter:'original'},sheet);
          for (const slot of PhotoBoothStrip.layout(template,sheet,0).slots) {
            for (const [x,y] of [[slot.x+2,slot.y+2],[slot.x+slot.width-3,slot.y+2],[slot.x+2,slot.y+slot.height-3],[slot.x+slot.width-3,slot.y+slot.height-3]]) {
              const pixel=Array.from(canvas.getContext('2d').getImageData(x,y,1,1).data).slice(0,3).join(',');
              if (pixel!=='18,72,160') return false;
            }
          }
        }
      }
      return true;
    })()`), true, 'Portrait and landscape photos must fill every slot edge to edge without white padding');
    assert.equal(await evaluate('window.__cameraRequests'), 0);
    await action(`document.querySelector('[data-color="#ddd0ef"]').click(); document.querySelector('[data-template=grid]').click(); document.getElementById('strip-theme').value = 'sakura'; document.getElementById('strip-theme').dispatchEvent(new Event('input')); document.getElementById('continue-camera').click()`);
    assert.deepEqual(await visibleStep(), ['camera-step']);
    assert.equal(await evaluate('document.getElementById("review-photos").disabled'), true);
    assert.equal(await evaluate('document.querySelector(".session-panel").hidden && document.getElementById("slots").getClientRects().length === 0'), true, 'Photo thumbnails and their edit actions must stay hidden during camera capture');
    await action(`window.__flowImage = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
      canvas.getContext('2d').fillRect(0, 0, 160, 100);
      return new File([await toBlob(canvas)], 'moment.png', {type:'image/png'});
    };`);
    await action('await uploadImages([await window.__flowImage()])');
    assert.deepEqual(await visibleStep(), ['camera-step']);
    await action('await uploadImages(await Promise.all(Array.from({length:3}, window.__flowImage)))');
    assert.deepEqual(await visibleStep(), ['preview-step']);
    assert.equal(await evaluate('document.getElementById("review-preview-host").contains(document.getElementById("strip-preview")) && document.getElementById("review-session-host").contains(document.getElementById("slots"))'), true);
    assert.equal(await evaluate('!document.querySelector(".session-panel").hidden && document.getElementById("slots").getClientRects().length > 0'), true, 'Photo thumbnails and edit actions must appear alongside the editable preview');
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".slot-actions")).every(actions => actions.children.length === 1 && actions.firstElementChild.classList.contains("retake-photo")) && !document.querySelector(".replace-photo, .clear-photo")'), true, 'Each photo must offer only Retake, with no Replace or delete button');
    assert.equal(await evaluate(`document.getElementById('review-design-host').contains(document.getElementById('design-controls')) && document.querySelector('[data-theme=tokyo]').getClientRects().length > 0 && document.querySelector('[data-color="#cde6f5"]').getClientRects().length > 0`), true, 'Frame designs and colors must be available on the photo preview screen');
    await action(`window.__previewPhotos = photos.map(photo => photo.url);
      document.querySelector('[data-color="#cde6f5"]').click();
      document.querySelector('[data-theme=tokyo]').click();
      await sleep(100); await renderStripPreview();`);
    assert.equal(await evaluate(`(async () => {
      const expected = await PhotoBoothStrip.render(photos.map(photo => photo.blob), stripStyle());
      return document.getElementById('strip-preview').toDataURL() === expected.toDataURL()
        && photos.every((photo,index) => photo.url === window.__previewPhotos[index])
        && document.querySelector('[data-theme=tokyo]').getAttribute('aria-pressed') === 'true'
        && document.querySelector('[data-color="#cde6f5"]').getAttribute('aria-pressed') === 'true';
    })()`), true, 'Changing the preview design must render the chosen frame and preserve every photo');
    await action('document.getElementById("continue-keep").click()');
    assert.deepEqual(await visibleStep(), ['keep-step']);
    assert.equal(await evaluate('!document.getElementById("save-strip").disabled && !document.getElementById("print").disabled && document.getElementById("frame-color").value === "#cde6f5" && document.getElementById("strip-theme").value === "tokyo"'), true);
    await action('document.getElementById("save-strip").click(); while (busy) await sleep(20)', true);
    for (let i=0; i<100 && !(await readdir(downloads)).some(name => name.endsWith('.png')); i++) await sleep(100);
    assert.ok((await readdir(downloads)).some(name => name.endsWith('.png')), 'Finished PNG downloads from the final screen');
    await action(`window.__printed = false; window.print = () => { window.__printed = true; window.dispatchEvent(new Event('afterprint')); }; document.getElementById('print').click(); while(busy) await sleep(20)`);
    assert.equal(await evaluate('window.__printed && document.getElementById("print-image").naturalWidth === 1800'), true);
    await action('document.getElementById("back-preview").click(); document.getElementById("retake-photos").click()');
    assert.deepEqual(await visibleStep(), ['camera-step']);
    assert.equal(await evaluate('photos.every(photo => !photo) && document.getElementById("save-strip").disabled'), true);
    // Use an actual browser video stream from canvas to verify capture transitions.
    await action(`window.__cameraCanvas = document.createElement('canvas'); window.__cameraCanvas.width = 320; window.__cameraCanvas.height = 240;
      window.__cameraCanvas.getContext('2d').fillRect(0,0,320,240);
      stream = window.__cameraCanvas.captureStream(15); video.srcObject = stream; await video.play();
      document.getElementById('capture-delay').value = '0'; updateControls();`);
    for(let i=0; i<4; i++) await action('await capturePhoto()');
    assert.deepEqual(await visibleStep(), ['preview-step']);
    assert.equal(await evaluate('photos.every(photo => photo.source === "camera")'), true);
    await action(`window.__beforeRetake = photos.map(photo => photo.url); document.querySelector('.retake-photo[data-index="1"]').click(); await sleep(300)`);
    assert.deepEqual(await visibleStep(), ['camera-step']);
    assert.equal(await evaluate('!countdown && !document.getElementById("capture").disabled && document.getElementById("capture").textContent.includes("Capture photo 2") && photos.every((photo,index) => photo.url === window.__beforeRetake[index])'), true, 'Retake with the timer off must wait for an explicit Capture click and preserve the old photo');
    assert.equal(await evaluate('document.querySelector(".session-panel").hidden'), true, 'Returning to the camera for a retake must hide photo review controls');
    await action('document.getElementById("review-photos").click()');
    assert.equal(await evaluate('pendingCaptureSlot === null && photos.every((photo,index) => photo.url === window.__beforeRetake[index])'), true, 'Returning to preview cancels a pending retake without replacing any photos');
    await action(`document.querySelector('.retake-photo[data-index="1"]').click(); document.getElementById('capture').click(); while(countdown) await sleep(20)`);
    assert.deepEqual(await visibleStep(), ['preview-step']);
    assert.equal(await evaluate('photos[1].url !== window.__beforeRetake[1] && photos.every((photo,index) => index === 1 || photo.url === window.__beforeRetake[index])'), true);
    await action(`document.querySelector('.retake-photo[data-index="2"]').click()`);
    assert.deepEqual(await visibleStep(), ['camera-step']);
    await action('await capturePhoto()');
    assert.deepEqual(await visibleStep(), ['preview-step']);
    for (const [width,height] of [[320,568],[390,844],[844,390],[820,1180],[1440,1100]]) {
      await command('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:width<1100});
      for (const step of ['design','camera','preview','keep']) {
        await action(`showStep('${step}')`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${step} overflow at ${width}x${height}`);
      }
    }
    await action('document.getElementById("reset").click(); stopCamera()');
    assert.deepEqual(await visibleStep(), ['design-step']);
    assert.equal(await evaluate('document.getElementById("frame-color").value === "#cde6f5" && document.getElementById("strip-theme").value === "tokyo" && document.getElementById("design-options-host").contains(document.getElementById("design-controls"))'), true);
    await action('document.querySelector("[data-template=polaroid]").click(); document.getElementById("continue-camera").click(); await uploadImages([await window.__flowImage()])');
    assert.deepEqual(await visibleStep(), ['preview-step']);
    assert.equal(await evaluate('photos.filter(Boolean).length'), 1);
    await action('document.getElementById("continue-keep").click(); document.getElementById("reset").click()');
    assert.deepEqual(await visibleStep(), ['design-step']);
    assert.deepEqual(errors, []);
    console.log('PASS: design, camera, automatic preview, individual/all retakes, saving/printing, reset, Polaroid, photo preservation and responsive screens.');
  } else if (process.argv.includes('--design-only')) {
    assert.equal(await evaluate(`(() => {
      const select = document.getElementById('strip-filter'), trigger = document.getElementById('strip-filter-trigger'), menu = document.getElementById('strip-filter-options');
      trigger.click();
      if (menu.hidden || trigger.getAttribute('aria-expanded') !== 'true' || menu.children.length !== Object.keys(PhotoBoothFilters.names).length || !select.hidden) return false;
      if (getComputedStyle(menu).backgroundColor !== 'rgb(255, 250, 251)') return false;
      menu.children[5].click();
      return menu.hidden && select.value === 'rosy' && trigger.textContent === 'Rosy' && document.getElementById('selected-filter').textContent === 'Selected filter: Rosy' && menu.children[5].getAttribute('aria-selected') === 'true';
    })()`), true, 'Themed dropdown must commit the actual filter and close without triggering the browser menu');
    await evaluate('document.getElementById("strip-filter-trigger").focus()');
    for (const key of ['ArrowDown','Home','ArrowDown','Enter']) {
      await command('Input.dispatchKeyEvent', {type:'keyDown',key,code:key,windowsVirtualKeyCode:{ArrowDown:40,Home:36,Enter:13}[key]});
      await command('Input.dispatchKeyEvent', {type:'keyUp',key,code:key,windowsVirtualKeyCode:{ArrowDown:40,Home:36,Enter:13}[key]});
    }
    assert.equal(await evaluate('document.getElementById("strip-filter").value === "bw" && document.getElementById("strip-filter-options").hidden'), true);
    await evaluate('document.getElementById("strip-filter-trigger").click()');
    await command('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert.equal(await evaluate('document.getElementById("strip-filter-options").hidden && document.getElementById("strip-filter").value === "bw"'), true);
    assert.equal(await evaluate(`(() => {
      const select = document.getElementById('strip-filter'); select.disabled = true; return Promise.resolve().then(() => document.getElementById('strip-filter-trigger').disabled);
    })()`), true);
    await evaluate('document.getElementById("strip-filter").value = "original"; document.getElementById("strip-filter").disabled = false; document.getElementById("strip-filter").dispatchEvent(new Event("input"))');
    assert.equal(await evaluate(`(async () => {
      const timer = document.getElementById('capture-delay-trigger'); timer.click();
      document.getElementById('capture-delay-options').children[2].click();
      if (document.getElementById('capture-delay').value !== '5' || timer.textContent !== '5 seconds') return false;
      for (const [index,theme] of ['none','sakura','tokyo','kyoto'].entries()) {
        document.querySelectorAll('.theme-choice')[index].click();
        await renderStripPreview();
        if (stripStyle().theme !== theme || document.getElementById('strip-theme-options').hidden !== true) return false;
      }
      document.querySelector('[data-template=polaroid]').click(); document.getElementById('polaroid-photo-trigger').click();
      document.getElementById('polaroid-photo-options').children[1].click();
      if (requiredIndices()[0] !== 1) return false;
      const camera = document.getElementById('device'); camera.append(new Option('Test camera label','test-camera'));
      await Promise.resolve();
      document.getElementById('device-trigger').click(); document.getElementById('device-options').lastElementChild.click();
      if (camera.value !== 'test-camera' || window.__cameraRequests !== 0) return false;
      camera.lastElementChild.remove(); camera.value = ''; camera.dispatchEvent(new Event('change'));
      document.getElementById('capture-delay').value = '3'; document.getElementById('capture-delay').dispatchEvent(new Event('change'));
      document.getElementById('strip-theme').value = 'none'; document.getElementById('strip-theme').dispatchEvent(new Event('input'));
      document.getElementById('polaroid-photo').value = '0'; document.getElementById('polaroid-photo').dispatchEvent(new Event('input'));
      document.querySelector('[data-template=classic]').click();
      return true;
    })()`), true, 'All themed dropdowns must update countdown, theme, Polaroid slot and dynamic device selection without requesting camera permission');
    const checkDesign = async () => {
      assert.equal(await evaluate(`getComputedStyle(document.documentElement).backgroundColor === 'rgb(251, 245, 247)' && document.title === 'MIST Photobooth'`), true, 'MIST branding and soft white stylesheet must load');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.viewfinder')).borderRadius === '24px' && getComputedStyle(document.querySelector('main')).display === 'grid' && getComputedStyle(document.getElementById('capture')).backgroundColor === 'rgb(237, 222, 228)' && document.querySelector('aside #design-controls') !== null`), true, 'Rounded camera, responsive grid and customization sidebar must be styled');
    };
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await checkDesign();
    assert.equal(await evaluate(`document.getElementById('camera-step').hidden && !document.getElementById('design-step').hidden`), true);
    const screenshot = await command('Page.captureScreenshot', { captureBeyondViewport: true });
    await writeFile(path.resolve('design-preview.png'), Buffer.from(screenshot.data, 'base64'));
    await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('camera-step').hidden && !document.getElementById('design-step').hidden`), true);
    const mobileScreenshot = await command('Page.captureScreenshot', { captureBeyondViewport: true });
    await writeFile(path.resolve('design-mobile-preview.png'), Buffer.from(mobileScreenshot.data, 'base64'));
    for (const [width,height] of [[320,568],[375,667],[390,844],[430,932],[568,320],[667,375],[844,390],[768,1024],[820,1180],[834,1194],[1024,1366],[1024,768],[1180,820],[1194,834],[1366,1024]]) {
      await command('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:true });
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `Overflow at ${width}x${height}`);
      assert.equal(await evaluate(`(() => {
        document.getElementById('open-strip-preview').click();
        const dialog = document.getElementById('frame-preview-dialog');
        const source = document.getElementById('strip-preview'), canvas = document.getElementById('full-frame-preview');
        const bounds = canvas.getBoundingClientRect(), box = dialog.getBoundingClientRect();
        const fits = dialog.open && canvas.toDataURL() === source.toDataURL() && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= box.top && bounds.bottom <= box.bottom && Math.abs(bounds.width / bounds.height - canvas.width / canvas.height) < .01;
        document.getElementById('close-strip-preview').click();
        return fits && !dialog.open;
      })()`), true, `Full frame preview must preserve all pixels and proportions at ${width}x${height}`);
      assert.equal(await evaluate(`(() => {
        const settings = document.getElementById('design-step').getBoundingClientRect();
        return settings.left >= 0 && settings.right <= innerWidth && document.getElementById('camera-step').hidden;
      })()`), true, `Layout must fit phone/iPad ${width}x${height}`);
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('#design-controls select,.camera-controls select')).filter(element => element.getClientRects().length).every(element => parseFloat(getComputedStyle(element).fontSize) >= (innerWidth <= 1100 ? 16 : 13))`), true, 'Small-screen inputs must avoid focus zoom');
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('button,select,input[type=color],.mirror')).filter(element => !element.disabled && element.getClientRects().length).every(element => { const rect=element.getBoundingClientRect(); return rect.width>=43.5 && rect.height>=43.5; })`), true, `Touch controls too small at ${width}x${height}`);
      await evaluate('showStep("camera")');
      if (width > height && height <= 600) assert.equal(await evaluate('document.querySelector(".viewfinder").getBoundingClientRect().height <= innerHeight * .61'), true, 'Phone landscape preview must fit the screen height');
      await evaluate('showStep("design")');
      assert.equal(await evaluate(`(() => {
        const trigger = document.getElementById('strip-filter-trigger'); trigger.scrollIntoView({block:'center'}); trigger.click();
        const menu = document.getElementById('strip-filter-options'), bounds = menu.getBoundingClientRect();
        const fits = !menu.hidden && bounds.left >= 0 && bounds.right <= innerWidth && bounds.height <= innerHeight * .5 + 2;
        document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
        return fits && menu.hidden;
      })()`), true, `Dropdown popup must fit and close on outside click at ${width}x${height}`);
      assert.equal(await evaluate(`(() => {
        showStep('camera');
        const counter = document.getElementById('countdown'), note = document.getElementById('capture-note');
        counter.textContent = '3'; counter.hidden = false;
        note.textContent = 'Retaking photo 2'; note.hidden = false;
        const camera = document.querySelector('.viewfinder').getBoundingClientRect(), timer = counter.getBoundingClientRect(), label = note.getBoundingClientRect();
        const style = getComputedStyle(counter);
        const fits = timer.width <= 72 && timer.height <= 72 && Math.abs(timer.left + timer.width/2 - camera.left - camera.width/2) < 2 && Math.abs(timer.top + timer.height/2 - camera.top - camera.height/2) < 2 && style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.borderTopWidth === '0px' && label.top >= timer.bottom;
        counter.hidden = true; note.hidden = true; showStep('design');
        return fits;
      })()`), true, `Countdown must be centered with a transparent background and no overlapping label at ${width}x${height}`);
      if (width === 834 && height === 1194) {
        const tabletScreenshot = await command('Page.captureScreenshot', { captureBeyondViewport:true });
        await writeFile(path.resolve('design-ipad-preview.png'),Buffer.from(tabletScreenshot.data,'base64'));
      }
    }
    console.log('PASS: 15 phone/iPad portrait and landscape sizes, touch targets, input sizing and short-screen previews.');
    await command('Emulation.setDeviceMetricsOverride', { width:390,height:844,deviceScaleFactor:1,mobile:true });
    await evaluate('document.getElementById("strip-filter-trigger").scrollIntoView({block:"center"}); document.getElementById("strip-filter-trigger").click()');
    const dropdownScreenshot = await command('Page.captureScreenshot');
    await writeFile(path.resolve('design-dropdown-preview.png'),Buffer.from(dropdownScreenshot.data,'base64'));
    await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await evaluate('document.querySelector(".theme-choices").scrollIntoView({block:"center"}); document.querySelector(".theme-choice[data-theme=tokyo]").click()');
    assert.equal(await evaluate(`document.getElementById('strip-theme').value === 'tokyo' && document.querySelector('.theme-choice[data-theme=tokyo]').getAttribute('aria-pressed') === 'true'`), true, 'Theme cards must update the chosen frame theme');
    const themeScreenshot = await command('Page.captureScreenshot');
    await writeFile(path.resolve('design-theme-selection-preview.png'),Buffer.from(themeScreenshot.data,'base64'));
    await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await command('Page.navigate', { url: pathToFileURL(path.resolve('web/index.html')).href });
    for (let i = 0; i < 100; i++) {
      if (await evaluate('typeof connectCamera === "function"')) break;
      await sleep(100);
    }
    await checkDesign();
    assert.deepEqual(errors, []);
    console.log('PASS: CSS and scripts load from localhost and directly opened HTML. Screenshot: design-preview.png');
  } else if (process.argv.includes('--context-only')) {
    assert.equal(await evaluate('window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)'), true);
    assert.equal(await evaluate('window.__cameraRequests'), 0);
    await command('Browser.setPermission', { permission: { name: 'camera' }, setting: 'granted', origin: url });
    await evaluate('(async () => { document.getElementById("connect").click(); while (connecting) await sleep(20); })()');
    const camera = await evaluate('({ready: Boolean(cameraReady()), width: video.videoWidth, height: video.videoHeight, status: document.getElementById("status").textContent})');
    assert.ok(camera.ready, JSON.stringify(camera));
    await evaluate('capturePhoto()');
    assert.equal(await evaluate('photos.filter(Boolean).length === 1 && photos[0].blob.size > 100 && photos[0].width === video.videoWidth && document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
    assert.equal(await evaluate('fetch("/api/save", {method:"POST", body:"test"}).then(() => false).catch(() => true)'), true);
    assert.equal(Object.entries(documentHeaders).find(([name]) => name.toLowerCase() === 'permissions-policy')?.[1], 'camera=(self), microphone=(), web-share=(self)');
    assert.ok(Object.entries(documentHeaders).find(([name]) => name.toLowerCase() === 'content-security-policy')?.[1].includes("connect-src 'none'"));
    await evaluate('document.getElementById("reset").click(); stopCamera()');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${url} is a secure context; real webcam ${camera.width} × ${camera.height}, local photo capture, camera policy, and blocked photo-network requests.`);
  } else {
  assert.equal(await evaluate('document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
  assert.equal(await evaluate('document.getElementById("save-strip").disabled'), true);
  await evaluate('savePhotoStrip()');
  assert.equal((await readdir(downloads)).length, 0);
  assert.equal(await evaluate('window.__cameraRequests'), 0, 'Page load must not request camera access');
  assert.equal(await evaluate('document.getElementById("connect").textContent'), 'Open camera');
  await evaluate('document.getElementById("device").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('window.__cameraRequests'), 0, 'Selecting a camera while closed must not request permission');
  await command('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: url });
  await evaluate('(async () => { document.getElementById("connect").click(); while (connecting) await sleep(20); })()');
  assert.equal(await evaluate('window.__cameraRequests'), 1);
  assert.equal(await evaluate('!document.getElementById("camera-error").hidden && document.getElementById("camera-error-message").textContent.includes("denied") && !document.getElementById("upload").disabled && document.getElementById("capture").disabled'), true);
  await evaluate(`window.__uploadFiles = async count => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
    const context = canvas.getContext('2d'); context.fillStyle = '#ef6548'; context.fillRect(0, 0, 160, 100);
    const blob = await toBlob(canvas);
    return Array.from({length:count}, (_, index) => new File([blob], 'upload-' + index + '.png', {type:'image/png'}));
  }`);
  await evaluate('uploadImages([new File(["not an image"], "notes.txt", {type:"text/plain"})])');
  assert.equal(await evaluate('photos.every(photo => photo === null) && document.getElementById("status").textContent.includes("Choose an image")'), true);
  await evaluate('uploadImages([new File(["broken PNG"], "broken.png", {type:"image/png"})])');
  assert.equal(await evaluate('photos.every(photo => photo === null) && document.getElementById("status").textContent.includes("cannot be opened")'), true);
  // Exercise the file input's actual change handler rather than only its helper.
  await evaluate(`(async () => {
    const files = await window.__uploadFiles(1), transfer = new DataTransfer();
    files.forEach(file => transfer.items.add(file));
    document.getElementById('image-files').files = transfer.files;
    document.getElementById('image-files').dispatchEvent(new Event('change'));
    while (busy) await sleep(20);
    window.__firstUploadUrl = photos[0].url;
  })()`);
  assert.equal(await evaluate('photos.filter(Boolean).length === 1 && photos[0].source === "upload" && photos[0].blob.type === "image/png" && document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
  assert.deepEqual(await evaluate(`Array.from(document.getElementById('capture-delay').options, option => option.textContent)`), ['Off','3 seconds','5 seconds','10 seconds']);
  await evaluate('window.__uploadFiles(4).then(uploadImages)');
  assert.equal(await evaluate('complete() && photos[0].url === window.__firstUploadUrl && !document.getElementById("save").disabled && !document.getElementById("print").disabled && document.getElementById("status").textContent.includes("extra image")'), true);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.template-choice'), button => button.dataset.template)`), ['classic','grid','polaroid']);
  assert.deepEqual(await evaluate(`Array.from(document.getElementById('strip-theme').options, option => option.textContent)`), ['Minimal ミニマル', 'Sakura 桜', 'Tokyo 東京', 'Kyoto 京都', 'Osaka 大阪', 'Hokkaido 北海道', 'Hanabi 花火', 'Tsuki 月', 'Umi 海', 'Mori 森', 'Love', 'Hoshi 星', 'Ribbon', 'Retro']);
  assert.equal(await evaluate(`(async () => {
    const urls = photos.map(photo => photo.url);
    for (const template of ['polaroid','grid','classic']) {
      document.querySelector('[data-template="' + template + '"]').click();
      await sleep(100); await renderStripPreview();
      if (photos.some((photo,index) => photo.url !== urls[index])) return false;
      if (document.querySelector('[data-template="' + template + '"]').getAttribute('aria-pressed') !== 'true') return false;
      if (!complete()) return false;
    }
    for (const swatch of document.querySelectorAll('.color-swatch')) {
      swatch.click(); await sleep(100); await renderStripPreview();
      if (document.getElementById('frame-color').value !== swatch.dataset.color || swatch.getAttribute('aria-pressed') !== 'true') return false;
      const rgb = swatch.dataset.color.match(/[a-f0-9]{2}/gi).map(value => parseInt(value,16));
      const pixel = document.getElementById('strip-preview').getContext('2d').getImageData(1,1,1,1).data;
      if (rgb.some((value,index) => value !== pixel[index])) return false;
    }
    document.getElementById('frame-color').value = '#123456'; document.getElementById('frame-color').dispatchEvent(new Event('input'));
    return [...document.querySelectorAll('.color-swatch')].every(button => button.getAttribute('aria-pressed') === 'false');
  })()`), true, 'Template changes preserve every photo; preset and custom frame colors must affect rendered pixels');
  assert.equal(await evaluate(`(async () => {
    const sources = [];
    for (const color of ['#ee3333','#33aa33','#3355ee','#dda033']) {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0,0,32,32); sources.push(await toBlob(canvas));
    }
    const centerColors = [[238,51,51],[51,170,51],[51,85,238],[221,160,51]];
    for (const template of ['classic','grid','polaroid']) {
      const style = {...stripStyle(),template,filter:'original',frameColor:'#efd0da',photoIndex:2,theme:'none'};
      const geometry = PhotoBoothStrip.layout(template, false, 2);
      const base = await PhotoBoothStrip.render(sources,style);
      const baseContext = base.getContext('2d');
      const plainMargin = PhotoBoothFiles.crc32(baseContext.getImageData(0,100,60,geometry.height - 350).data);
      const photoHashes = geometry.slots.map(slot => PhotoBoothFiles.crc32(baseContext.getImageData(slot.x,slot.y,slot.width,slot.height).data));
      for (const slot of geometry.slots) {
        const pixel = baseContext.getImageData(slot.x + slot.width / 2,slot.y + slot.height / 2,1,1).data;
        if (centerColors[slot.index].some((value,index) => pixel[index] !== value)) return false;
      }
      const designs = new Set([base.toDataURL()]);
      for (const theme of ['sakura','tokyo','kyoto','osaka','hokkaido','hanabi','tsuki','umi','mori','love','hoshi','ribbon','retro']) {
        const output = await PhotoBoothStrip.render(sources,{...style,theme});
        const context = output.getContext('2d');
        if (PhotoBoothFiles.crc32(context.getImageData(0,100,60,geometry.height - 350).data) === plainMargin) return false;
        if (geometry.slots.some((slot,index) => PhotoBoothFiles.crc32(context.getImageData(slot.x,slot.y,slot.width,slot.height).data) !== photoHashes[index])) return false;
        designs.add(output.toDataURL());
        const png = await PhotoBoothFiles.pngWithDpi(await toBlob(output),300);
        const image = await createImageBitmap(png);
        const decoded = PhotoBoothFilters.draw(image,image.width,image.height,'original'); image.close();
        if (decoded.toDataURL() !== output.toDataURL()) return false;
      }
      if (designs.size !== 14) return false;
    }
    return true;
  })()`), true, 'Themes must visibly alter every template, survive PNG encoding, and leave all photo pixels untouched');
  console.log('Template layouts, photo preservation, frame presets/custom color, and face-safe exported theme decorations passed.');
  assert.deepEqual(await evaluate(`Array.from(document.getElementById('strip-filter').options, option => option.textContent)`), ['Original', 'Black & White', 'Mono', 'Vintage', 'Sepia', 'Rosy', 'Soft', 'Warm glow', 'Cool breeze', 'Peach', 'Lavender', 'Faded film', 'Vivid']);
  const filterTones = await evaluate(`(() => {
    const fixture = document.createElement('canvas'); fixture.width = 3; fixture.height = 1;
    const ctx = fixture.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray([64,64,64,255,192,192,192,255,239,101,72,255]), 3, 1), 0, 0);
    const result = {};
    for (const filter of Object.keys(PhotoBoothFilters.names)) result[filter] = [...PhotoBoothFilters.draw(fixture, 3, 1, filter).getContext('2d').getImageData(0,0,3,1).data];
    return result;
  })()`);
  assert.deepEqual(filterTones.original, [64,64,64,255,192,192,192,255,239,101,72,255]);
  assert.deepEqual(filterTones.bw.slice(0,8), [64,64,64,255,192,192,192,255]);
  assert.deepEqual(filterTones.mono.slice(0,8), [32,32,32,255,224,224,224,255]);
  for (const filter of ['bw','mono']) assert.equal(filterTones[filter][8] === filterTones[filter][9] && filterTones[filter][9] === filterTones[filter][10], true);
  for (const filter of ['vintage','sepia','rosy','soft','warm','cool','peach','lavender','faded','vivid']) assert.notDeepEqual(filterTones[filter], filterTones.original);
  assert.equal(await evaluate(`(async () => {
    for (const [filter, name] of Object.entries(PhotoBoothFilters.names)) {
      document.getElementById('strip-filter').value = filter;
      document.getElementById('strip-filter').dispatchEvent(new Event('input'));
      await sleep(100); await renderPhotoPreviews(); await renderStripPreview();
      if (document.getElementById('selected-filter').textContent !== 'Selected filter: ' + name) return false;
      const expected = await createImageBitmap(photos[0].blob);
      const canvas = PhotoBoothFilters.draw(expected, expected.width, expected.height, filter); expected.close();
      const tone = canvas.getContext('2d').getImageData(80,50,1,1).data.join(',');
      const thumbnailTone = document.querySelector('[data-photo-index="0"]').getContext('2d').getImageData(80,50,1,1).data.join(',');
      const stripTone = document.getElementById('strip-preview').getContext('2d').getImageData(400,350,1,1).data.join(',');
      if (thumbnailTone !== tone) throw new Error(filter + ' thumbnail: ' + thumbnailTone + ', expected ' + tone);
      if (stripTone !== tone) throw new Error(filter + ' strip: ' + stripTone + ', expected ' + tone);
      const files = await localFiles();
      const saved = await createImageBitmap(files[0].blob);
      const copy = PhotoBoothFilters.draw(saved, saved.width, saved.height, 'original'); saved.close();
      const savedTone = copy.getContext('2d').getImageData(80,50,1,1).data.join(',');
      if (savedTone !== tone) throw new Error(filter + ' export: ' + savedTone + ', expected ' + tone);
    }
    return true;
  })()`), true, 'All filters must agree across uploaded thumbnails, strip pixels and individual exports');
  await evaluate(`(async () => {
    document.getElementById('strip-filter').value = 'mono';
    document.getElementById('strip-template').value = 'polaroid';
    document.getElementById('frame-color').value = '#123456';
    document.getElementById('strip-theme').value = 'sakura';
    document.getElementById('strip-theme').dispatchEvent(new Event('input'));
    await renderStripPreview();
  })()`);
  assert.equal(await evaluate('document.getElementById("strip-preview").width === 1200 && document.getElementById("strip-preview").height === 1500 && !document.getElementById("save-strip").disabled'), true);
  const previewData = await evaluate('document.getElementById("strip-preview").toDataURL("image/png")');
  const previewPath = path.join(folder, 'preview.png');
  await writeFile(previewPath, Buffer.from(previewData.split(',')[1], 'base64'));
  await evaluate('(async () => { document.getElementById("save-strip").click(); while (busy) await sleep(20); })()');
  let strips = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    strips = (await readdir(downloads)).filter(name => name.endsWith('_strip.png'));
    if (strips.length) break;
    await sleep(100);
  }
  assert.equal(strips.length, 1);
  execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c', `
import sys
from PIL import Image, ImageChops
with Image.open(sys.argv[1]) as image, Image.open(sys.argv[2]) as preview:
    assert image.format == 'PNG' and image.size == (1200, 1500)
    assert abs(image.info['dpi'][0] - 300) < 0.1
    assert image.getpixel((1, 1))[:3] == (18, 52, 86), 'frame color missing'
    pixel = image.getpixel((600, 350))[:3]
    assert pixel[0] == pixel[1] == pixel[2] and pixel[0] > 0, 'monochrome filter missing'
    assert image.getpixel((27, 150))[:3] == (164, 84, 114), 'sakura blossom decoration missing'
    assert image.getpixel((85, 80))[:3] == (255, 255, 255), 'polaroid border missing'
    assert ImageChops.difference(image.convert('RGBA'), preview.convert('RGBA')).getbbox() is None, 'export differs from visible preview'
`, path.join(downloads, strips[0]), previewPath], { windowsHide: true });
  assert.equal(await evaluate('window.__saveRequests'), 0);
  // Native mobile share sheets need a physical phone. Stub only the platform
  // boundary here and inspect the real rendered PNG file passed to that API.
  await command('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
  await evaluate(`(() => {
    window.__shareCalls = []; window.__shareMode = 'success';
    Object.defineProperty(navigator, 'canShare', {configurable:true, writable:true, value: data => data.files?.length === 1 && data.files[0] instanceof File && data.files[0].type === 'image/png'});
    Object.defineProperty(navigator, 'share', {configurable:true, writable:true, value: data => {
      window.__shareCalls.push({file:data.files[0], keys:Object.keys(data), activated:navigator.userActivation.isActive});
      if (!navigator.userActivation.isActive) return Promise.reject(new DOMException('Missing user activation', 'NotAllowedError'));
      if (window.__shareMode === 'cancel') return Promise.reject(new DOMException('Cancelled', 'AbortError'));
      if (window.__shareMode === 'error') return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
      return Promise.resolve();
    }});
  })()`);
  await evaluate('renderStripPreview()');
  assert.equal(await evaluate('!document.getElementById("share-strip").hidden && !document.getElementById("share-strip").disabled'), true);
  await evaluate('(async () => { document.getElementById("share-strip").click(); while(busy) await sleep(20); })()', true);
  assert.equal(await evaluate('window.__shareCalls.length === 1 && window.__shareCalls[0].activated && window.__shareCalls[0].keys.join(",") === "files" && window.__shareCalls[0].file.name.endsWith("_strip.png")'), true);
  const sharedData = await evaluate(`new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject;
    reader.readAsDataURL(window.__shareCalls[0].file);
  })`);
  const sharedPath = path.join(folder, 'shared.png');
  await writeFile(sharedPath, Buffer.from(sharedData.split(',')[1], 'base64'));
  execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c', `
import sys
from PIL import Image, ImageChops
with Image.open(sys.argv[1]) as shared, Image.open(sys.argv[2]) as downloaded:
    assert shared.size == (1200, 1500) and shared.format == 'PNG'
    assert abs(shared.info['dpi'][0] - 300) < 0.1
    assert ImageChops.difference(shared.convert('RGBA'), downloaded.convert('RGBA')).getbbox() is None
`, sharedPath, path.join(downloads, strips[0])], { windowsHide: true });
  await evaluate('window.__shareMode = "cancel"; sharePhotoStrip()', true);
  assert.equal(await evaluate('complete() && !busy && document.getElementById("status").textContent.includes("cancelled") && !document.getElementById("save-strip").disabled'), true);
  await evaluate('window.__shareMode = "error"; sharePhotoStrip()', true);
  assert.equal(await evaluate('complete() && !busy && document.getElementById("status").textContent.includes("download the PNG") && !document.getElementById("save-strip").disabled'), true);
  assert.equal((await readdir(downloads)).filter(name => name.endsWith('_strip.png')).length, 1, 'Cancellation or share failure must not silently download');
  await evaluate('document.getElementById("frame-color").value = "#654321"; document.getElementById("frame-color").dispatchEvent(new Event("input"))');
  assert.equal(await evaluate('shareStripFile === null && document.getElementById("share-strip").disabled'), true, 'Style changes must invalidate the prepared share image');
  await evaluate('navigator.canShare = () => false; renderStripPreview()');
  assert.equal(await evaluate('document.getElementById("share-strip").hidden && !document.getElementById("save-strip").disabled'), true);
  assert.equal(await evaluate('!document.getElementById("download-fallback").hidden && document.getElementById("gallery-instructions").textContent.includes("Save Image")'), true);
  await evaluate('(async () => { document.getElementById("save-strip").click(); while(busy) await sleep(20); })()', true);
  let fallbackStrips = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    fallbackStrips = (await readdir(downloads)).filter(name => name.endsWith('_strip.png'));
    if (fallbackStrips.length === 2) break;
    await sleep(100);
  }
  assert.equal(fallbackStrips.length, 2, 'Unsupported mobile sharing must still allow a PNG download');
  assert.equal(await evaluate('document.getElementById("gallery-help").open && complete() && !busy'), true);
  execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c', `
import sys
from PIL import Image
with Image.open(sys.argv[1]) as image:
    assert image.format == 'PNG' and image.size == (1200, 1500)
    assert abs(image.info['dpi'][0] - 300) < 0.1
    assert image.getpixel((1, 1))[:3] == (101, 67, 33)
`, path.join(downloads, fallbackStrips.at(-1))], { windowsHide: true });
  await evaluate('delete navigator.share; delete navigator.canShare');
  await command('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36' });
  await evaluate('document.getElementById("frame-color").value = "#123456"; renderStripPreview()');
  // Other templates and filters render into pixels as well, without relying on CSS.
  assert.equal(await evaluate(`(async () => {
    const blobs = photos.map(photo => photo.blob);
    const rounded = await PhotoBoothStrip.render(blobs, {...stripStyle(), template:'grid', filter:'sepia', theme:'kyoto'});
    const context = rounded.getContext('2d'), pixel = context.getImageData(450, 350, 1, 1).data;
    if (rounded.width !== 1800 || rounded.height !== 1800 || !(pixel[0] > pixel[1] && pixel[1] > pixel[2])) return false;
    const corner = context.getImageData(90, 90, 1, 1).data;
    if (corner[0] !== 18 || corner[1] !== 52 || corner[2] !== 86) return false;
    const original = await PhotoBoothStrip.render(blobs, {...stripStyle(), filter:'original', theme:'none'});
    const vintage = await PhotoBoothStrip.render(blobs, {...stripStyle(), filter:'vintage', theme:'tokyo'});
    return original.getContext('2d').getImageData(600, 350, 1, 1).data.join(',') !== vintage.getContext('2d').getImageData(600, 350, 1, 1).data.join(',');
  })()`), true);
  await evaluate('savePhotos()');
  await checkDownloads(1);
  assert.equal(await evaluate('window.__saveRequests'), 0, 'Local saving must not upload photos');
  // Use a real browser filesystem directory as a selected-folder fixture.
  // The native picker itself remains a manual, user-controlled action.
  await evaluate(`window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    window.__selectedFolder = await root.getDirectoryHandle('chosen-folder', {create:true});
    return window.__selectedFolder;
  }; savePhotos({folder:true})`);
  assert.equal(await evaluate(`(async () => {
    const sessions = []; for await (const value of window.__selectedFolder.values()) sessions.push(value);
    if (sessions.length !== 1) return false;
    const files = []; for await (const entry of sessions[0].values()) files.push(entry);
    if (files.length !== 5) return false;
    return (await files.find(file => file.name === 'print_6x4.png').getFile()).size > 100;
  })()`), true);
  await evaluate('window.showDirectoryPicker = async () => { throw new DOMException("Cancelled", "AbortError"); }; savePhotos({folder:true})');
  assert.equal(await evaluate('complete() && !busy && document.getElementById("status").textContent.includes("cancelled")'), true);
  await evaluate(`window.showDirectoryPicker = async () => ({name:'test-folder', getDirectoryHandle:async () => ({
    getFileHandle:async () => ({createWritable:async () => ({write:async () => {throw new DOMException('Disk full','QuotaExceededError');}, close:async () => {}, abort:async () => {}})})
  })}); savePhotos({folder:true})`);
  assert.equal(await evaluate('complete() && !busy && document.getElementById("status").textContent.includes("Save failed") && !document.getElementById("save").disabled'), true);
  assert.equal(await evaluate('window.__saveRequests'), 0);
  await evaluate('window.showDirectoryPicker = undefined; document.querySelector(\"[data-template=classic]\").click(); updateControls()');
  assert.equal(await evaluate('document.getElementById("save-folder").hidden'), true);
  await evaluate('URL.revokeObjectURL(photos[1].url); photos[1] = null; invalidatePrint(); renderSlots()');
  assert.equal(await evaluate('document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
  assert.equal(await evaluate('document.getElementById("save-strip").disabled'), true);
  await evaluate('document.getElementById("reset").click()');
  await command('Browser.setPermission', { permission: { name: 'camera' }, setting: 'granted', origin: url });
  await evaluate('(async () => { document.getElementById("connect").click(); while (connecting) await sleep(20); })()');
  const ready = await evaluate('({ready: Boolean(cameraReady()), width: video.videoWidth, height: video.videoHeight, status: document.getElementById("status").textContent})');
  assert.ok(ready.ready, JSON.stringify(ready));
  console.log(`Live getUserMedia preview: ${ready.width} × ${ready.height}`);
  assert.equal(await evaluate(`(async () => {
    video.pause();
    for (const [filter, name] of Object.entries(PhotoBoothFilters.names)) {
      document.getElementById('strip-filter').value = filter;
      document.getElementById('strip-filter').dispatchEvent(new Event('input'));
      drawCameraPreview();
      const preview = document.getElementById('camera-preview');
      const expected = PhotoBoothFilters.draw(video, preview.width, preview.height, filter);
      if (expected.toDataURL() !== document.getElementById('camera-preview').toDataURL()) return false;
      if (!document.getElementById('camera-preview').getAttribute('aria-label').includes(name)) return false;
    }
    return true;
  })()`), true, 'Every live camera filter must use the same pixels as saved-photo processing');
  for (let index = 0; index < 4; index++) {
    const startCapture = Date.now();
    await evaluate('capturePhoto()');
    assert.ok(Date.now() - startCapture >= 2800, 'The 3-second timer must wait before capturing');
    assert.equal(await evaluate('photos.filter(Boolean).length'), index + 1);
    assert.equal(await evaluate('document.getElementById("save").disabled'), index !== 3);
    assert.equal(await evaluate('document.getElementById("print").disabled'), index !== 3);
    assert.equal(await evaluate(`photos[${index}].blob.size > 100 && photos[${index}].width === video.videoWidth`), true);
    assert.equal(await evaluate('document.getElementById("progress").textContent'), `${index + 1} of 4 photos ready`);
  }
  assert.equal(await evaluate(`(async () => {
    const urls = photos.map(photo => photo.url);
    const nativeTimeout = window.setTimeout;
    const counter = document.getElementById('countdown');
    try {
      for (const seconds of [5,10]) {
        const ticks = [], waits = [];
        const observer = new MutationObserver(() => { if (!counter.hidden) ticks.push(Number(counter.textContent)); });
        observer.observe(counter, {childList:true});
        window.setTimeout = (callback,delay,...args) => { if (delay === 1000) { waits.push(delay); return nativeTimeout(callback,30,...args); } return nativeTimeout(callback,delay,...args); };
        document.getElementById('capture-delay').value = String(seconds);
        document.getElementById('capture-delay').dispatchEvent(new Event('change'));
        const pendingCapture = capturePhoto(0);
        if (!countdown || counter.hidden || counter.textContent !== String(seconds) || !document.getElementById('capture-delay').disabled) return false;
        const note = document.getElementById('capture-note');
        const previewBounds = document.querySelector('.viewfinder').getBoundingClientRect();
        const timerBounds = counter.getBoundingClientRect();
        if (note.hidden || note.textContent !== 'Retaking photo 1' || timerBounds.width > 72 || timerBounds.height > 72) return false;
        if (timerBounds.left <= previewBounds.left + previewBounds.width / 2 || timerBounds.top <= previewBounds.top + previewBounds.height / 2) return false;
        if (note.getBoundingClientRect().right >= timerBounds.left) return false;
        await capturePhoto(1);
        document.getElementById('reset').click();
        if (photos[1].url !== urls[1] || photos.some(photo => !photo)) return false;
        await pendingCapture; observer.disconnect();
        if (waits.length !== seconds || waits.some(delay => delay !== 1000) || ticks.join(',') !== Array.from({length:seconds},(_,index) => seconds-index).join(',')) return false;
        if (photos[0].url === urls[0] || photos.slice(1).some((photo,index) => photo.url !== urls[index+1]) || countdown || !counter.hidden || !note.hidden) return false;
      }
    } finally { window.setTimeout = nativeTimeout; }
    const before = photos.map(photo => photo.url);
    document.getElementById('capture-delay').value = '0'; document.getElementById('capture-delay').dispatchEvent(new Event('change'));
    document.querySelector('.retake-photo[data-index="1"]').click();
    if (countdown || photos.some((photo,index) => photo.url !== before[index]) || document.getElementById('capture').disabled) return false;
    document.getElementById('capture').click();
    await capturePhoto(2);
    while (countdown) await sleep(10);
    if (photos[1].url === before[1] || photos[2].url !== before[2] || photos[0].url !== before[0] || photos[3].url !== before[3]) return false;
    if (document.getElementById('shutter-flash').classList.contains('active') !== true || !counter.hidden) return false;
    return complete() && !document.getElementById('save-strip').disabled;
  })()`), true, '5/10-second timers must step once per second; duplicate captures/reset are blocked, Off and slot retakes must work');
  assert.equal(await evaluate(`(async () => {
    const input = document.getElementById('image-files');
    const nativeClick = input.click;
    input.click = () => {};
    try {
      const before = photos.map(photo => photo.url);
      replacementSlot = 2; input.multiple = false;
      if (input.multiple || replacementSlot !== 2) return false;
      input.dispatchEvent(new Event('cancel'));
      if (replacementSlot !== null || !input.multiple || photos[2].url !== before[2]) return false;
      replacementSlot = 2; input.multiple = false;
      let transfer = new DataTransfer(); (await window.__uploadFiles(1)).forEach(file => transfer.items.add(file)); input.files = transfer.files;
      input.dispatchEvent(new Event('change')); while (busy) await sleep(10);
      if (photos[2].url === before[2] || photos[2].source !== 'upload' || photos.some((photo,index) => index !== 2 && photo.url !== before[index])) return false;
      const replaced = photos[2].url;
      replacementSlot = 2; input.multiple = false;
      transfer = new DataTransfer(); transfer.items.add(new File(['broken'],'broken.png',{type:'image/png'})); input.files = transfer.files;
      input.dispatchEvent(new Event('change')); while (busy) await sleep(10);
      return photos[2].url === replaced && complete() && input.multiple && replacementSlot === null;
    } finally { input.click = nativeClick; }
  })()`), true, 'Individual upload replacement must target only its slot and preserve photos on cancel or invalid images');
  console.log('Countdown options, duplicate guards, shutter flash, real-camera retakes, individual replacement and cancellation passed.');
  await evaluate('renderPhotoPreviews()');
  assert.equal(await evaluate(`(async () => {
    const image = await createImageBitmap(photos[0].blob);
    const scale = Math.min(1, 480 / Math.max(image.width, image.height));
    const expected = PhotoBoothFilters.draw(image, Math.round(image.width * scale), Math.round(image.height * scale), selectedFilter()); image.close();
    return expected.toDataURL() === document.querySelector('[data-photo-index="0"]').toDataURL();
  })()`), true, 'Captured photos must display the selected filter without double application');
  await evaluate('video.play()');
  await evaluate('savePhotos()');
  await checkDownloads(2);
  assert.equal(await evaluate('window.__saveRequests'), 0);
  await evaluate(`(async () => {
    const download = PhotoBoothFiles.download;
    const objectUrl = URL.createObjectURL;
    try {
      PhotoBoothFiles.download = blob => { window.__exportedStrip = blob; };
      await savePhotoStrip();
      URL.createObjectURL = blob => { window.__printedStrip = blob; return objectUrl.call(URL, blob); };
      window.print = () => {
        window.__printCalled = document.getElementById('print-image').complete && document.getElementById('print-image').naturalWidth > 0;
        window.dispatchEvent(new Event('beforeprint')); window.dispatchEvent(new Event('afterprint'));
      };
      await printPhotos();
    } finally { PhotoBoothFiles.download = download; URL.createObjectURL = objectUrl; }
  })()`);
  assert.equal(await evaluate('window.__exportedStrip === window.__printedStrip && window.__printedStrip.type === "image/png"'), true, 'Print view must use the exact exported high-resolution PNG Blob');
  assert.equal(await evaluate('window.__printCalled && document.getElementById("print-image").naturalWidth === document.getElementById("strip-preview").width && !busy && !printPending'), true);
  assert.equal(await evaluate(`(() => {
    const preview = document.getElementById('strip-preview');
    const copy = document.createElement('canvas'); copy.width = preview.width; copy.height = preview.height;
    copy.getContext('2d').drawImage(document.getElementById('print-image'), 0, 0);
    return copy.toDataURL() === preview.toDataURL();
  })()`), true, 'Printing must preserve every styled preview pixel');
  for (const template of ['classic', 'grid', 'polaroid']) {
    await evaluate(`document.getElementById('strip-template').value = '${template}'; window.print = () => {}; printPhotos()`);
    const pdf = await command('Page.printToPDF', { paperWidth: 8.5, paperHeight: 11, displayHeaderFooter: false, printBackground: true });
    const pdfPath = path.join(folder, `${template}.pdf`);
    await writeFile(pdfPath, Buffer.from(pdf.data, 'base64'));
    execFileSync(path.resolve('.venv/Scripts/python.exe'), ['-c', `
import re, sys
data = open(sys.argv[1], 'rb').read()
assert len(re.findall(rb'/Type\\s*/Page\\b', data)) == 1, 'Strip must fit on one page'
assert b'/Subtype /Image' in data, 'Finished strip image must be embedded'
assert re.search(rb'/Width\\s+' + sys.argv[2].encode() + rb'\\b', data)
assert re.search(rb'/Height\\s+' + sys.argv[3].encode() + rb'\\b', data)
`, pdfPath, template === 'polaroid' ? '1200' : template === 'grid' ? '1800' : '900', template === 'polaroid' ? '1500' : template === 'grid' ? '1800' : '2700'], { windowsHide: true });
    await command('Emulation.setEmulatedMedia', { media: 'print' });
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('main')).display === 'none' && getComputedStyle(document.getElementById('print-notice')).display === 'none' && getComputedStyle(document.getElementById('print-image')).objectFit === 'contain'`), true);
    assert.equal(await evaluate(`(() => {
      const image = document.getElementById('print-image');
      const style = getComputedStyle(image);
      return [...document.body.children].filter(element => element.id !== 'print-area').every(element => getComputedStyle(element).display === 'none')
        && Math.abs(parseFloat(style.width) / parseFloat(style.height) - image.naturalWidth / image.naturalHeight) < 0.001
        && getComputedStyle(document.getElementById('print-area')).breakInside === 'avoid'
        && [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).some(rule => rule.cssText.startsWith('@page') && rule.style.margin === '0.25in');
    })()`), true, 'Print CSS must hide every app section, preserve image proportions, and set paper margins');
    await command('Emulation.setEmulatedMedia', { media: '' });
    await evaluate('window.dispatchEvent(new Event("afterprint"))');
    assert.equal(await evaluate('!busy && !printPending && !document.getElementById("print").disabled'), true);
  }
  await evaluate('window.print = () => { throw new Error("Printing unavailable"); }; printPhotos()');
  assert.equal(await evaluate('!busy && !printPending && complete() && document.getElementById("status").textContent.includes("Save photo strip")'), true);
  console.log('Styled strips print on one PDF page; cancellation and unavailable-print recovery passed.');
  await evaluate('document.querySelector("[data-template=classic]").click(); URL.revokeObjectURL(photos[2].url); photos[2] = null; invalidatePrint(); renderSlots()');
  assert.equal(await evaluate('!complete() && document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
  await evaluate('window.__printCalled = false; window.print = () => { window.__printCalled = true; }; printPhotos(); window.dispatchEvent(new Event("beforeprint"))');
  assert.equal(await evaluate('!window.__printCalled && document.getElementById("print-area").dataset.ready === "false"'), true);
  assert.equal(await evaluate('fetch("/api/save", {method:"POST", body:"test"}).then(() => false).catch(() => true)'), true);
  await evaluate('document.getElementById("reset").click(); stopCamera()');
  assert.equal(await evaluate('photos.every(photo => photo === null) && video.srcObject === null'), true);
  assert.equal(await evaluate(`(async () => {
    document.querySelector('[data-template=polaroid]').click();
    if (!document.getElementById('save-strip').disabled) return false;
    await uploadImages(await window.__uploadFiles(1));
    if (!complete() || document.getElementById('save-strip').disabled || photos.filter(Boolean).length !== 1) return false;
    const first = photos[0].url;
    const exported = await prepareStripExport();
    if (exported.width !== 1200 || exported.height !== 1500 || exported.png.size < 100) return false;
    document.querySelector('[data-template=grid]').click();
    if (complete() || !document.getElementById('print').disabled || photos[0].url !== first) return false;
    await uploadImages(await window.__uploadFiles(3));
    if (!complete() || photos[0].url !== first) return false;
    document.querySelector('[data-template=polaroid]').click();
    document.getElementById('polaroid-photo').value = '2'; document.getElementById('polaroid-photo').dispatchEvent(new Event('input'));
    if (!complete() || requiredIndices()[0] !== 2 || photos.filter(Boolean).length !== 4) return false;
    URL.revokeObjectURL(photos[2].url); photos[2] = null; invalidatePrint(); renderSlots();
    if (complete() || !document.getElementById('save-strip').disabled || photos.filter(Boolean).length !== 3) return false;
    document.querySelector('[data-template=classic]').click(); document.getElementById('reset').click();
    return photos.every(photo => photo === null);
  })()`), true, 'Single Polaroid needs one selected photo; switching to four-photo templates must retain photos and gate missing slots');
  await evaluate('navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("No camera", "NotFoundError"); }; connectCamera()');
  assert.equal(await evaluate('!document.getElementById("camera-error").hidden && document.getElementById("camera-error-message").textContent.includes("No camera") && !document.getElementById("upload").disabled'), true);
  await evaluate('navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Device busy", "NotReadableError"); }; connectCamera()');
  assert.equal(await evaluate('document.getElementById("camera-error-message").textContent.includes("Close other camera apps") && !document.getElementById("upload").disabled'), true);
  await evaluate('navigator.mediaDevices.getUserMedia = window.__spyGetCamera');
  // Simulate front/back device metadata around the real webcam stream. This checks
  // phone switching behavior without claiming a physical phone was tested.
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await command('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36' });
  await evaluate('updateControls()');
  assert.equal(await evaluate('document.getElementById("gallery-instructions").textContent.includes("copy it to Pictures")'), true);
  await evaluate(`(() => {
    const media = navigator.mediaDevices;
    const getCamera = media.getUserMedia.bind(media);
    const supported = media.getSupportedConstraints.bind(media);
    window.__cameraTest = { calls: [], streams: [], unavailable: false };
    media.getSupportedConstraints = () => ({ ...supported(), facingMode: true });
    media.enumerateDevices = async () => [
      {kind:'videoinput', deviceId:'test-front', label:'Front camera'},
      {kind:'videoinput', deviceId:'test-back', label:'Back camera'}
    ];
    media.getUserMedia = async constraints => {
      const mode = constraints.video.facingMode?.exact || constraints.video.facingMode?.ideal || (constraints.video.deviceId?.exact === 'test-back' ? 'environment' : 'user');
      const previous = window.__cameraTest.streams.at(-1);
      if (previous && previous.getVideoTracks()[0].readyState !== 'ended') throw new Error('Previous camera was not released before switching');
      window.__cameraTest.calls.push(constraints);
      if (window.__cameraTest.unavailable && mode === 'environment') throw new DOMException('No back camera', 'OverconstrainedError');
      const acquired = await getCamera({audio:false, video:{width:{ideal:1280},height:{ideal:720}}});
      const track = acquired.getVideoTracks()[0], settings = track.getSettings.bind(track);
      track.getSettings = () => ({...settings(), facingMode:mode, deviceId: mode === 'environment' ? 'test-back' : 'test-front'});
      window.__cameraTest.streams.push(acquired);
      return acquired;
    };
  })()`);
  await evaluate('document.getElementById("device").value = ""; connectCamera()');
  assert.equal(await evaluate('activeFacing === "user" && !document.getElementById("switch-camera").hidden && document.getElementById("mirror").checked'), true);
  await evaluate('capturePhoto()');
  assert.equal(await evaluate('photos.filter(Boolean).length'), 1);
  await evaluate('switchCamera()');
  assert.equal(await evaluate('activeFacing === "environment" && !document.getElementById("mirror").checked && photos.filter(Boolean).length === 1'), true);
  assert.equal(await evaluate('window.__cameraTest.calls.at(-1).video.facingMode.exact'), 'environment');
  assert.equal(await evaluate('document.getElementById("switch-camera").textContent'), 'Switch to front camera');
  await evaluate('switchCamera()');
  assert.equal(await evaluate('activeFacing === "user" && document.getElementById("mirror").checked'), true, JSON.stringify(await evaluate('({ facing: activeFacing, mirror: document.getElementById("mirror").checked, status: document.getElementById("status").textContent })')));
  await evaluate('window.__cameraTest.unavailable = true; switchCamera()');
  assert.equal(await evaluate('Boolean(cameraReady()) && activeFacing === "user" && document.getElementById("switch-camera").hidden && photos.filter(Boolean).length === 1'), true);
  assert.equal(await evaluate('document.getElementById("save").disabled && document.getElementById("print").disabled'), true);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  for (const width of [320,360,390,768,1440]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 850 });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `Horizontal overflow at ${width}px`);
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('button,select,input[type=color],.mirror,summary')).filter(element => !element.disabled && element.getClientRects().length).every(element => { const rect = element.getBoundingClientRect(); return rect.width >= 43.5 && rect.height >= 43.5; })`), true, `Active controls must have 44px touch targets at ${width}px`);
  }
  await command('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
  assert.equal(await evaluate('getComputedStyle(document.getElementById("shutter-flash")).animationName'), 'none');
  await command('Emulation.setEmulatedMedia', { features:[] });
  await evaluate('showStep("camera"); document.getElementById("capture-delay-trigger").focus()');
  await command('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  await command('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
  await command('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate(`(() => { const control = document.getElementById('capture-delay-trigger'); return document.activeElement === control && getComputedStyle(control).outlineStyle !== 'none'; })()`), true, 'Actual keyboard navigation must show a focus outline');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.slot button,.template-choice,.color-swatch')).every(button => Boolean(button.getAttribute('aria-label') || button.textContent.trim()))`), true);
  assert.equal(await evaluate(`document.querySelector('link[rel=icon]').getAttribute('href')`), 'favicon.svg');
  assert.equal(await evaluate(`(async () => {
    const luminance = hex => {
      const values = hex.match(/[a-f0-9]{2}/gi).map(value => parseInt(value,16)/255).map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
      return values[0]*.2126 + values[1]*.7152 + values[2]*.0722;
    };
    const ratio = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
    for (const [foreground,background] of [['#44313a','#fbf5f7'],['#a45472','#fbf5f7'],['#755966','#fbf5f7'],['#44313a','#efd0da']]) if (ratio(foreground,background) < 4.5) return false;
    for (const color of ['#efd0da','#fff3df','#ddd0ef','#cde6f5','#292839','#888888','#999999','#777777']) {
      const canvas = await PhotoBoothStrip.render(Array(4).fill(null),{...stripStyle(),frameColor:color,template:'polaroid'});
      if (ratio(canvas.getContext('2d').fillStyle,color) < 4.5) return false;
    }
    return true;
  })()`), true, 'Interface and exported frame text must meet 4.5:1 contrast, including custom midtone colors');
  console.log('Keyboard focus, labels, contrast, 44px touch controls, reduced motion, favicon and 320–1440px overflow checks passed.');
  await evaluate('document.getElementById("reset").click(); stopCamera()');
  assert.deepEqual(errors, []);
  console.log('PASS: mobile sharing passes the styled high-resolution PNG File with active user gesture; cancellation, errors, unsupported sharing and stale-image protection pass. Strip export, ZIPs, folders, camera, gating and mobile switching also pass.');
  }
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: 99999, method: 'Browser.close' }));
    await sleep(500);
  }
  if (socket) socket.close();
  for (const child of [chrome, server]) {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await Promise.race([exited, sleep(3000)]);
    }
  }
  await sleep(500);
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir()));
  assert.ok(path.basename(folder).startsWith('photobooth-browser-'));
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
