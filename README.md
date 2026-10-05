# MIST Photobooth

A local browser photo booth with a real getUserMedia camera, live preview, selectable countdowns, template-aware photo slots, local saving, and printing.

Double-click **Start PhotoBooth.bat** to open http://127.0.0.1:8765. Keep the launcher window open. Python 3.10 or newer is required; the web launcher uses only Python's standard library and installs no imaging dependencies.

Choose your frame/template, colors, filter and theme first, then click **Continue to camera**. Once the required photos are captured or uploaded, the booth opens a preview screen with individual retakes, replacements, and **Retake photos** for the whole design. **Continue to save / print** opens the separate download, save and print screen. Back buttons preserve your photos and design; **Start a new strip** returns to design selection. Run `node test_browser.mjs --flow-only` to check this flow.

1. Click **Open camera** to request camera access, then allow it in the browser permission prompt. Loading the page and choosing a device while the camera is closed never request camera permission. The camera dropdown lists desktop webcams and mobile cameras after permission is granted. On phones with multiple cameras, **Switch to back camera / Switch to front camera** selects the requested direction. The current stream is stopped before switching. If that direction is unavailable, the previous camera reconnects. Captured slots are preserved when switching.
2. Choose **Countdown**: Off, 3 seconds, 5 seconds, or 10 seconds. **Capture photo** captures one actual live video frame at native resolution per click, after the chosen countdown. A large counter appears over the preview and a subtle shutter flash confirms capture. Duplicate clicks and editing are blocked until capture finishes. **Mirror photos** applies to preview and captures.
3. Classic and Grid require all four photo slots; Single Polaroid requires just its selected slot. Fill slots by capturing photos or choosing **Upload images**. Uploads fill empty slots without replacing existing photos; you can select several images at once. Save and Print stay disabled until every slot required by the current template is filled. Clearing a slot or resetting disables them immediately.
4. **Download photo set** saves a ZIP directly to your device using the browser's download location. It contains all filled session photos as full-resolution PNGs with the selected filter and a 1800 x 1200 print layout at 300 dpi. Extract the ZIP to access the images. On browsers supporting folder access, **Save to folder…** lets you choose a local folder and writes the session photos and print sheet into a new timestamped subfolder. Both options require the current template to be complete.
5. **Print photo strip…** opens the browser print dialog with the finished high-resolution strip, including its filter, template, frame color, and decorations. Choose a printer or Save as PDF, portrait paper, fit to page, and disable browser headers and footers. Classic strips print at 3 x 9 inches; Grid at 6 x 6 inches; Polaroid at 4 x 5 inches on Letter/A4 paper. Smaller paper requires scaling to fit. Printing does not require saving first. Closing or cancelling the dialog preserves your photos; the browser cannot confirm physical printer output. If your browser/device does not offer printing, save the PNG and print it from another app.

## Design

Each slot has **Capture/Retake**, **Upload/Replace**, and **Clear** actions. Retake requires the live camera; image replacement opens a single-image picker for that slot. The previous photo stays intact until the new frame/image succeeds, including when image selection is cancelled or invalid. Other slots are preserved. **Start a new strip** clears the session and keeps your design preferences. Progress reads, for example, "2 of 4 photos ready."

The implemented design lives in `web/styles.css`: mist pink (#EFD0DA), soft white (#FBF5F7), dusty rose (#A45472), and dark plum (#44313A). Design selection, camera, photo review, and saving/printing each appear on their own screen. Local serif headings, rounded panels, subtle shadows, and reduced-motion-aware animations keep the booth cozy without remote fonts or a landing page.

Phone, iPad, and desktop layouts show one step at a time. Phone landscape uses a shorter preview sized to the screen height. Form inputs use 16px text on smaller screens, touch controls remain at least 44px, and safe-area spacing accommodates screen cutouts. `node test_browser.mjs --design-only` checks 15 phone/iPad portrait and landscape sizes and writes desktop, phone, and iPad screenshots.

Dropdowns use the MIST palette through `web/app.js`: rounded soft-white menus, mist-pink selected options, dusty-rose borders, and selection checkmarks. They support arrow keys, Home/End, typing to find an option, Enter/Space to select, Escape to cancel, and outside-click dismissal. Camera-device options update dynamically and do not request camera permission until Open camera is chosen. Menu checks run with the design tests; `design-dropdown-preview.png` shows the open filter menu.

## Save a finished photo strip

Choose your **Filter**, **Template**, **Frame color**, and **Theme** in the strip editor. The preview includes the complete design and updates when photos or styling change. **Save photo strip** downloads one high-resolution PNG directly to your device, including the filtered photos, selected template, colored frame, theme decorations, and date caption. It stays disabled until the current template is complete.

On desktop, **Save photo strip** starts a normal browser download of the PNG. It goes to the browser's configured download folder, or the browser asks you to choose a location if that setting is enabled. The image is generated on the device and is not sent to the server.

On supported mobile browsers, **Share / Save to Photos** opens the native share sheet with the finished strip as an actual `image/png` file. Choose an available destination such as Photos, Files, or another installed app. The device determines which saving destinations are available; the booth cannot guarantee or automatically select Photos. The button appears only when the browser supports sharing image files, and stays disabled until the required photos and the prepared image are ready. The PNG is prepared before the click so opening the share sheet retains the required user activation.

Cancelling the share sheet preserves the photos. If sharing is unsupported or fails, **Save photo strip** remains available to download the same high-resolution image. The app does not automatically send the image to any share destination.

A browser cannot automatically write directly to every device's photo gallery. A download creates a file; adding it to Photos or a gallery requires the user to choose an available share-sheet action or follow their device's manual import steps.

On mobile, unavailable file sharing displays a download hint and **Save photo strip** remains the PNG fallback. After a PNG download, the app expands brief gallery instructions for the phone:

- **iPhone/iPad:** Open the PNG in Files → Downloads, tap Share, and choose Save Image or Save to Photos if offered. Available actions vary by iOS version and app.
- **Android:** Open the PNG in your file manager's Downloads folder. If it is not visible in Gallery or Google Photos, copy it to Pictures and reopen the gallery.

These steps follow [Apple's Files guidance](https://support.apple.com/en-ie/guide/iphone/iphc61044c11/ios) and [Google's file-copy guidance](https://support.google.com/files/answer/9808834?hl=en).

Classic strips export at **900 × 2700 pixels**, 2×2 grids at **1800 × 1800 pixels**, and single-photo Polaroids at **1200 × 1500 pixels**. All exports contain **300 dpi** metadata. Available filters are Original, Black & White, Mono, Vintage, Sepia, Rosy, and Soft; themes are Minimal, Sakura, Tokyo, and Kyoto. The same pixel transforms apply to the live camera preview, captured and uploaded photo thumbnails, individual PNGs in ZIP/folder downloads, and the finished strip. Black & White uses neutral grayscale; Mono adds stronger contrast. Soft gently lifts shadows and lowers contrast; Rosy adds a pink tint. The current filter is labeled beside the controls. Original restores the source appearance because filters never accumulate on the stored source images. Live preview processing is bounded to 1280 pixels on its longest edge and 15 fps for mobile performance; captures and exports retain their full resolution. The 6 × 4 print sheet also includes the selected photo filter, frame color, and theme.

Photos remain in browser memory until saved. Closing, reloading, or resetting discards unsaved photos. Browser saving makes no network requests: photos save on the device using the booth, even when the website is hosted on another computer. The ZIP download works without a folder-access API; the browser may ask where to save or use its configured Downloads folder. Folder-picker cancellation preserves the photos; folder errors leave downloads available.

All camera capture, uploaded-image decoding, resizing, filters, framing, decorations, previews, PNG generation, DPI metadata, and ZIP creation happen in the browser. The web server serves static assets only: it has no image-processing dependency or photo-saving endpoint and rejects POST requests without processing their bodies. The page's Content Security Policy blocks application network connections. Sharing sends a locally generated file only to the destination you explicitly choose in the native share sheet; the app does not automatically upload images.

## Templates, colors, and themes

Select a template using its rendered thumbnail. Classic uses four vertically stacked photos; Grid uses a 2x2 arrangement; Single Polaroid uses one selected session photo. Switching templates never deletes session photos. Choose a different photo in the Polaroid photo dropdown, or return to Classic/Grid to use all four. Clearing a required slot disables exports immediately; clearing a preserved, unused slot does not invalidate a completed Polaroid.

Frame presets are Mist pink (#EFD0DA), Cream (#FFF3DF), Lilac (#DDD0EF), Sky blue (#CDE6F5), and Midnight (#292839). The custom color picker accepts any color; the selected preset or custom hex value is labeled. Template thumbnails and the live frame update with color/theme changes.

Theme cards also set the frame text: **Minimal / Simply you**, **Sakura ? / Cherry blossom**, **Tokyo ?? / City postcards**, and **Kyoto ?? / Quiet moments**. The selected title replaces MIST PHOTOBOOTH, and its caption appears alongside the session date in previews, saved images, and print layouts.

Minimal keeps the frame quiet. Sakura adds cherry blossoms, fine branches, and pink accents. Tokyo adds Japanese postcard typography, clean double borders, and a postal stamp. Kyoto adds restrained seigaiha-inspired wave patterns and a small seal. Decorations are clipped to frame space outside all photo areas and Polaroid cards. The exact same decorated high-resolution PNG is used for saving and printing.

## Mobile access

Front/back selection uses the browser's `facingMode` support, falling back to known device IDs when needed. The switch is hidden for a single desktop webcam. Front camera photos are mirrored by default; back camera photos are not. Changing **Mirror photos** overrides the automatic choice. The preview uses `playsinline` for iPhone/iPad and fits portrait and landscape frames.

A phone must open an **HTTPS address with a certificate trusted by that phone**. The computer's HTTP localhost address only works on the computer itself. To serve the booth on your network, provide a PEM certificate and private key for the hostname or IP address your phone will use:

```powershell
py -3 server.py --host 0.0.0.0 --port 8765 --cert "C:\certs\photobooth.pem" --key "C:\certs\photobooth.key" --public-url "https://photobooth.example:8765"
```

Replace the example address with your certificate's real hostname/IP address, make sure it resolves to this computer, and open that address on the phone. Allow the chosen port through the computer's firewall if needed. Network access requires the explicit HTTPS configuration; the app never silently exposes the default local server. Only the configured address and same-origin save requests are accepted.

## Development and HTTPS deployment

For development, start the launcher and open `http://localhost:8765` or `http://127.0.0.1:8765`. Browsers allow camera access on these loopback HTTP origins. Camera permission is still requested only when **Open camera** is clicked.

When deployed, open the app at a trusted `https://` address. You can use the direct TLS options above, or terminate HTTPS at a reverse proxy while keeping the Python backend on loopback HTTP:

```powershell
py -3 server.py --behind-proxy --public-url "https://photobooth.example" --no-browser
```

An example proxy configuration is in `deploy/nginx.conf.example`. Replace the domain and certificate paths with real values. The proxy must preserve the browser's `Host` header, redirect public HTTP to HTTPS, and serve the page and its static assets from the configured origin. The backend does not trust forwarded headers to infer its public address; the HTTPS origin is configured explicitly.

All browser assets use the current origin, with no hard-coded localhost URLs in the app. Saving ZIPs and writing local folders do not use a server API. The server allows same-origin camera and sharing through `Permissions-Policy: camera=(self), microphone=(), web-share=(self)`. If embedding the booth in an iframe, its HTTPS parent must permit camera and sharing access and the iframe must include `allow="camera; web-share"`.

Plain HTTP on a LAN IP or public domain cannot request camera access. The app explains this and keeps image uploads available. An untrusted or expired HTTPS certificate must be corrected on the server; browser security settings do not need to be disabled to run the app.

Camera access requires localhost or HTTPS. Start through the launcher rather than opening the HTML file directly. If permission is denied, allow camera access in the browser site settings and choose **Open camera** again. Close other camera applications if the device is busy. Windows camera privacy settings must allow desktop application access. A helpful message and **Upload images** remain available when camera permission is denied, no camera exists, or the device cannot be used.

Uploads do not require camera permission. Select browser-readable images such as JPEG, PNG, or WebP (up to 20 MB each). Uploaded images retain their displayed orientation and are not mirrored. They are normalized to PNG, with very large images scaled to a maximum dimension of 4096 pixels. Unsupported or damaged files are skipped with an explanation; valid files still fill empty slots. Additional files are skipped once the current template's required slots are filled.

Manual launch: `py -3 server.py`. Open `http://127.0.0.1:8765`. Use `--port 8766` for another port. Choose a device folder through **Save to folder…**, or change your browser's download settings for ZIP downloads.

The app uses static HTML/CSS/JavaScript and Python's standard-library server; there is no npm build step. Syntax checks are `node --check web/app.js`, `node --check web/filters.js`, `node --check web/strip-renderer.js`, `node --check web/local-save.js`, and `py -3 -m py_compile server.py`.

Accessibility checks cover keyboard focus, named controls, 44px active touch targets, reduced-motion behavior, text contrast, and absence of horizontal overflow from 320px to 1440px. The SVG favicon uses the MIST palette. Capture tests use the real webcam; the 3-second delay is timed in real time, while 5/10-second stepping is tested using accelerated timers that verify every requested 1000ms interval. Countdown, retake, replacement, cancellation, and duplicate-click checks preserve session photos as intended.

Run static-server checks with `py -3 -m unittest test_server -v`. Run `node test_browser.mjs` for Chrome integration checks using the real webcam and automated permission approval. Browser image-validation tests use Pillow from the development `.venv`; the application server itself requires no third-party dependencies. The browser test also simulates phone camera metadata to check front/back requests, release of the previous stream, mirroring, unavailable-camera recovery, and a 390px portrait layout. HTTPS tests use a temporary test certificate when OpenSSL is installed. A physical phone is needed to confirm device-specific camera and print behavior. The app never substitutes a fake camera.

The browser check downloads ZIPs, verifies their checksums and all five PNGs with Python, and checks the print layout's dimensions and 300 dpi metadata. Folder-write behavior is checked using a browser filesystem fixture; folder-picker cancellation and write failures are simulated. Native folder selection remains a user action. The check also verifies that local saving sends no photos to the server.

Mobile-share checks simulate the native API boundary and inspect the actual PNG `File`, including its 300 dpi metadata and pixels. They verify user activation, cancellation, blocked sharing, unsupported file sharing, and invalidation after styling changes. A physical phone is needed to verify its native share sheet and available destinations.

Check development camera access with `node test_browser.mjs --localhost --context-only`. Check a non-localhost HTTPS origin with `node test_browser.mjs --https --deployed-origin --context-only`. The HTTPS test uses an ephemeral certificate, approves only its key fingerprint in a temporary Chrome profile, and maps `photobooth.test` to the test server. This test-only configuration does not change operating-system trust or disable secure-context checks; a real deployment requires a certificate trusted by users' browsers.


Additional themes: **Osaka 大阪** (city lights), **Hokkaido 北海道** (snowflakes), **Hanabi 花火** (fireworks), and **Tsuki 月** (moon and stars). All eight theme names display Japanese text beside the English name in the selection cards and on exported frames.
