from pathlib import Path
import tempfile
import unittest
import http.client
import json
import ssl
import subprocess
import threading
from http.server import ThreadingHTTPServer
from server import Handler


class QuietHandler(Handler):
    def log_message(self, *_):
        pass


class NetworkAccessTests(unittest.TestCase):
    def test_proxy_backend_serves_configured_https_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
            server.scheme = "http"
            server.public_url = "https://photobooth.example"
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request("GET", "/", headers={"Host": "photobooth.example"})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(response.getheader("Permissions-Policy"), "camera=(self), microphone=(), web-share=(self)")
                self.assertIn("connect-src 'none'", response.getheader("Content-Security-Policy"))
                response.read()
                for route, mime in [("/favicon.svg", "image/svg+xml"), ("/styles.css", "text/css"), ("/filters.js", "text/javascript"), ("/app.js", "text/javascript")]:
                    connection.request("GET", route, headers={"Host": "photobooth.example"})
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertTrue(response.getheader("Content-Type").startswith(mime))
                    asset = response.read()
                    self.assertTrue(asset)
                    if route == "/favicon.svg":
                        import xml.etree.ElementTree as ET
                        self.assertEqual(ET.fromstring(asset).tag, "{http://www.w3.org/2000/svg}svg")
                payload = json.dumps({"photos": ["private image data"] * 4})
                connection.request("POST", "/api/save", body=payload, headers={"Host": "photobooth.example", "Origin": server.public_url, "Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 405)
                self.assertIn("entirely in your browser", json.loads(response.read())["error"])
                connection.request("POST", "/api/save", body=payload, headers={"Host": "photobooth.example", "Origin": "https://untrusted.example", "Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 405)
                response.read()
                self.assertEqual(list(Path(directory).iterdir()), [])
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)

    def test_proxy_configuration_rejects_public_http_and_network_backend(self):
        import sys
        for options in [
            ["--behind-proxy", "--public-url", "http://photobooth.example"],
            ["--behind-proxy", "--public-url", "https://photobooth.example", "--host", "0.0.0.0"],
        ]:
            result = subprocess.run([sys.executable, "server.py", "--no-browser", *options], capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 2)

    def test_network_mode_requires_https_configuration(self):
        import sys
        result = subprocess.run([sys.executable, "server.py", "--host", "0.0.0.0", "--no-browser"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires --cert, --key, and --public-url", result.stderr)

    @unittest.skipUnless(Path("C:/Program Files/Git/usr/bin/openssl.exe").exists(), "OpenSSL is needed for the temporary HTTPS test certificate")
    def test_https_serves_assets_and_rejects_photo_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            cert, key = folder / "cert.pem", folder / "key.pem"
            subprocess.run(["C:/Program Files/Git/usr/bin/openssl.exe", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-days", "1"], check=True, capture_output=True, timeout=10)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
            server.scheme = "https"
            server.public_url = f"https://localhost:{server.server_port}"
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client_context = ssl.create_default_context(cafile=str(cert))
                connection = http.client.HTTPSConnection("localhost", server.server_port, context=client_context, timeout=5)
                connection.request("GET", "/")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b"switch-camera", response.read())
                connection.request("GET", "/", headers={"Host": "untrusted.example"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                payload = json.dumps({"photos": ["private image data"] * 4})
                connection.request("POST", "/api/save", body=payload, headers={"Content-Type": "application/json", "Origin": "https://untrusted.example"})
                response = connection.getresponse()
                self.assertEqual(response.status, 405)
                response.read()
                connection.request("POST", "/api/save", body=payload, headers={"Content-Type": "application/json", "Origin": server.public_url})
                response = connection.getresponse()
                self.assertEqual(response.status, 405)
                response.read()
                self.assertEqual(sorted(file.name for file in folder.iterdir()), ["cert.pem", "key.pem"])
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
