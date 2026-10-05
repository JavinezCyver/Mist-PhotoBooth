"""Serve Photo Booth's static files over localhost or HTTPS; no photo processing."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import ssl
from pathlib import Path
import threading
import webbrowser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


class Handler(BaseHTTPRequestHandler):
    def allowed_origins(self):
        scheme = getattr(self.server, "scheme", "http")
        origins = {f"{scheme}://127.0.0.1:{self.server.server_port}", f"{scheme}://localhost:{self.server.server_port}"}
        public_url = getattr(self.server, "public_url", None)
        if public_url:
            origins.add(public_url)
        return origins

    def local_host(self):
        return self.headers.get("Host") in {urlsplit(origin).netloc for origin in self.allowed_origins()}

    def respond(self, code, data, content_type="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Permissions-Policy", "camera=(self), microphone=(), web-share=(self)")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'")
        self.end_headers()
        self.wfile.write(data)

    def json_response(self, code, payload):
        self.respond(code, json.dumps(payload).encode())

    def do_GET(self):
        if not self.local_host():
            return self.json_response(403, {"error": "This address is not enabled for Photo Booth."})
        files = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/local-save.js": ("local-save.js", "text/javascript; charset=utf-8"), "/strip-renderer.js": ("strip-renderer.js", "text/javascript; charset=utf-8"), "/filters.js": ("filters.js", "text/javascript; charset=utf-8"), "/favicon.svg": ("favicon.svg", "image/svg+xml"), "/styles.css": ("styles.css", "text/css; charset=utf-8")}
        route = files.get(self.path.split("?", 1)[0])
        if not route:
            return self.json_response(404, {"error": "Not found."})
        file, content_type = route
        self.respond(200, (ROOT / "web" / file).read_bytes(), content_type)

    def do_POST(self):
        # Do not read, decode, or write request bodies. Photos belong in the browser.
        self.json_response(405, {"error": "Photo processing and saving run entirely in your browser."})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; network access requires direct HTTPS")
    parser.add_argument("--cert", type=Path, help="PEM HTTPS certificate trusted by the phone")
    parser.add_argument("--key", type=Path, help="PEM certificate private key")
    parser.add_argument("--public-url", help="Enabled HTTPS address, such as https://photobooth.example:8765")
    parser.add_argument("--behind-proxy", action="store_true", help="Use a loopback HTTP backend behind an HTTPS reverse proxy")
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key):
        parser.error("Supply both --cert and --key for HTTPS.")
    if args.behind_proxy and (args.cert or not args.public_url or args.host not in {"127.0.0.1", "localhost"}):
        parser.error("--behind-proxy requires --public-url and a loopback bind address, without --cert or --key.")
    if args.host not in {"127.0.0.1", "localhost"} and not (args.cert and args.public_url):
        parser.error("Mobile network access requires --cert, --key, and --public-url.")
    if args.public_url:
        parsed = urlsplit(args.public_url)
        if not (args.cert or args.behind_proxy) or parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            parser.error("--public-url must be an HTTPS origin with direct TLS or --behind-proxy and no path or credentials.")
        args.public_url = f"https://{parsed.netloc}"
    context = None
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.scheme = "https" if context else "http"
    server.public_url = args.public_url
    if context:
        server.socket = context.wrap_socket(server.socket, server_side=True)
    url = args.public_url or f"{server.scheme}://127.0.0.1:{server.server_port}"
    print(f"Photo Booth: {url}", flush=True)
    print("Photos are processed in your browser. Keep this window open. Press Ctrl+C to stop.", flush=True)
    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
