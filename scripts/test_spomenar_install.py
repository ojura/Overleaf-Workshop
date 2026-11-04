"""Stable-share preflight and nginx routing tests using only small temporary files."""

from email.utils import formatdate
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import re
import shutil
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "spomenar_install", Path(__file__).with_name("spomenar-install.py"))
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)
NATIVE_URI = "/nextcloud/public.php/dav/files/stable-token"
NGINX = shutil.which("nginx")


class PublicShare:
    """A native endpoint fixture: its stable token resolves the current small file per request."""

    def __init__(self, root):
        self.file = root / "Original.pdf"
        self.file.write_bytes(b"%PDF-1.7\n" + b"original page\n" * 16)
        self.revoked = False
        self.requests = []
        self.modified = formatdate(1_700_000_000, usegmt=True)
        self.response_filter = lambda method, result: result

    def response(self, method, uri, headers):
        headers = {name.lower(): value for name, value in headers.items()}
        self.requests.append((method, uri, headers))
        if uri != NATIVE_URI or self.revoked:
            return 404, {"Content-Length": "0"}, b""
        content = self.file.read_bytes()
        etag = '"' + hashlib.sha256(content).hexdigest() + '"'
        fields = {"Content-Type": "application/pdf", "Content-Length": str(len(content)),
                  "ETag": etag, "Last-Modified": self.modified,
                  "X-Accel-Buffering": "no"}
        status = 200
        body = b"" if method == "HEAD" else content
        requested = headers.get("range")
        if (method == "GET" and requested
                and headers.get("if-range", etag) in (etag, self.modified)):
            match = re.fullmatch(r"bytes=([0-9]+)-([0-9]+)", requested)
            begin, end = map(int, match.groups()) if match else (len(content), 0)
            if begin > end or begin >= len(content):
                status, body = 416, b""
                fields["Content-Range"] = f"bytes */{len(content)}"
            else:
                status = 206
                end = min(end, len(content) - 1)
                body = content[begin:end + 1]
                fields["Content-Range"] = f"bytes {begin}-{end}/{len(content)}"
            fields["Content-Length"] = str(len(body))
        return self.response_filter(method, (status, fields, body))


class HttpShareHandler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.respond()

    def do_GET(self):
        self.respond()

    def respond(self):
        status, headers, body = self.server.share.response(
            self.command, self.path, dict(self.headers))
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def log_message(self, *_args):
        pass


class NativePreflightTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="spomenar-share-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.share = PublicShare(self.root)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), HttpShareHandler)
        self.server.share = self.share
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.close_server, thread)
        origin = f"http://127.0.0.1:{self.server.server_port}"
        self.settings = {"url": origin + "/spomenar/", "shareUrl": origin + "/nextcloud/s/stable-token"}

    def close_server(self, thread):
        self.server.shutdown()
        self.server.server_close()
        thread.join()

    def test_preflight_observes_native_metadata_and_only_a_small_conditional_range(self):
        pdf = INSTALL.public_pdf(self.settings)
        self.assertEqual(pdf["url"], self.settings["shareUrl"].replace("/s/", "/public.php/dav/files/"))
        self.assertEqual(pdf["bytes"], self.share.file.stat().st_size)
        self.assertEqual(pdf["validator"]["header"], "ETag")
        self.assertNotIn("file", pdf)
        self.assertEqual([entry[0] for entry in self.share.requests], ["HEAD", "GET"])
        self.assertEqual(self.share.requests[-1][2]["range"], "bytes=0-15")
        self.assertEqual(self.share.requests[-1][2]["if-range"], pdf["validator"]["value"])

    def test_public_url_uses_only_the_token_and_requires_the_site_origin(self):
        settings = dict(self.settings, shareUrl=self.settings["shareUrl"].replace("/s/", "/index.php/s/"))
        self.assertEqual(INSTALL.public_pdf_url(settings), INSTALL.public_pdf_url(self.settings))
        for bad in [
            "https://elsewhere.test/nextcloud/s/stable-token",
            self.settings["shareUrl"] + "?files=another.pdf",
            self.settings["shareUrl"].replace("stable-token", ".."),
            self.settings["shareUrl"].replace("stable-token", "nested%2Ftoken"),
        ]:
            with self.subTest(url=bad), self.assertRaises(ValueError):
                INSTALL.public_pdf_url(dict(self.settings, shareUrl=bad))

    def test_preflight_follows_renames_and_replacement_without_a_local_path(self):
        first = INSTALL.public_pdf(self.settings)
        moved = self.root / "Renamed folder" / "Kako je LARICS postao 30-godišnjak - WEB.pdf"
        moved.parent.mkdir()
        self.share.file.rename(moved)
        self.share.file = moved
        self.assertEqual(INSTALL.public_pdf(self.settings), first)
        moved.write_bytes(b"%PDF-2.0\nreplacement\n")
        replacement = INSTALL.public_pdf(self.settings)
        self.assertNotEqual(replacement["validator"], first["validator"])
        self.assertEqual(replacement["bytes"], moved.stat().st_size)
        self.share.revoked = True
        with self.assertRaisesRegex(RuntimeError, "HTTP 404"):
            INSTALL.public_pdf(self.settings)

    def test_preflight_rejects_redirects_encoded_or_inconsistent_ranges(self):
        for fault in ["redirect", "full", "encoding", "range", "length", "validator", "truncated", "not-pdf"]:
            def corrupt(method, result):
                status, fields, body = result
                if method == "GET":
                    if fault == "redirect":
                        status, fields, body = 303, {"Location": "/renamed.pdf", "Content-Length": "0"}, b""
                    elif fault == "full":
                        status = 200
                    elif fault == "encoding":
                        fields["Content-Encoding"] = "gzip"
                    elif fault == "range":
                        fields["Content-Range"] = "bytes 1-16/999"
                    elif fault == "length":
                        fields["Content-Length"] = "17"
                    elif fault == "validator":
                        fields["ETag"] = '"replacement"'
                    elif fault == "truncated":
                        body = body[:4]
                    elif fault == "not-pdf":
                        body = b"x" * len(body)
                return status, fields, body
            self.share.response_filter = corrupt
            with self.subTest(fault=fault), self.assertRaises(RuntimeError):
                INSTALL.public_pdf(self.settings)

    def test_a_full_range_response_is_closed_before_any_body_read(self):
        head = mock.Mock(status=200)
        values = {"Content-Length": "1608358464", "Content-Type": "application/pdf",
                  "ETag": '"current"', "Content-Encoding": "identity"}
        head.getheader.side_effect = lambda name, default=None: values.get(name, default)
        whole = mock.Mock(status=200)
        connections = [mock.Mock(), mock.Mock()]
        connections[0].getresponse.return_value = head
        connections[1].getresponse.return_value = whole
        with mock.patch.object(INSTALL.http.client, "HTTPConnection", side_effect=connections):
            with self.assertRaisesRegex(RuntimeError, "expected 206"):
                INSTALL.public_pdf(self.settings)
        whole.read.assert_not_called()
        whole.close.assert_called_once()
        connections[1].close.assert_called_once()

    def test_php_adapter_is_idempotent_and_rejects_ambiguous_handlers(self):
        source = "location ~ php {\n    include fastcgi_params;\n    fastcgi_pass php-handler;\n}\n"
        adapted = INSTALL.native_request_uri(source)
        self.assertEqual(INSTALL.native_request_uri(adapted), adapted)
        self.assertIn("fastcgi_param REQUEST_URI $spomenar_request_uri;", adapted)
        for bad in ["", source + source, source.replace("php-handler", "another-handler")]:
            with self.subTest(source=bad), self.assertRaises(RuntimeError):
                INSTALL.native_request_uri(bad)


class FastcgiShareHandler(socketserver.StreamRequestHandler):
    """Minimal FastCGI responder for observing nginx's real forwarded parameter stream."""

    def handle(self):
        encoded = bytearray()
        request_id = 1
        while True:
            header = self.rfile.read(8)
            if not header:
                return
            version, kind, request_id, length, padding, _reserved = struct.unpack("!BBHHBB", header)
            if version != 1:
                return
            content = self.rfile.read(length)
            self.rfile.read(padding)
            if kind == 4:
                encoded.extend(content)
            if kind == 5 and not content:
                break
        offset = 0

        def next_length():
            nonlocal offset
            value = encoded[offset]
            if value & 0x80:
                value = int.from_bytes(encoded[offset:offset + 4], "big") & 0x7fffffff
                offset += 4
            else:
                offset += 1
            return value

        params = {}
        while offset < len(encoded):
            name_size, value_size = next_length(), next_length()
            name = bytes(encoded[offset:offset + name_size]).decode()
            offset += name_size
            params[name] = bytes(encoded[offset:offset + value_size]).decode()
            offset += value_size
        self.server.params.append(params)
        headers = {name[5:].replace("_", "-"): value for name, value in params.items() if name.startswith("HTTP_")}
        status, fields, body = self.server.share.response(params["REQUEST_METHOD"], params["REQUEST_URI"], headers)
        payload = (f"Status: {status}\r\n"
                   + "".join(f"{name}: {value}\r\n" for name, value in fields.items())
                   + "\r\n").encode() + body

        def record(kind, data):
            self.wfile.write(struct.pack("!BBHHBB", 1, kind, request_id, len(data), 0, 0) + data)

        record(6, payload)
        record(6, b"")
        record(3, b"\x00" * 8)


class UnixHttpConnection(http.client.HTTPConnection):
    def __init__(self, filename):
        super().__init__("localhost", timeout=5)
        self.filename = str(filename)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.filename)


@unittest.skipUnless(NGINX, "nginx is required for the isolated routing fixture")
class NativeNginxRoutingTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="spomenar-nginx-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.share = PublicShare(self.root)
        self.http_socket = self.root / "http.sock"
        self.fcgi = socketserver.UnixStreamServer(str(self.root / "fcgi.sock"), FastcgiShareHandler)
        self.fcgi.share = self.share
        self.fcgi.params = []
        thread = threading.Thread(target=self.fcgi.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.close_fcgi, thread)
        (self.root / "nextcloud").mkdir()
        (self.root / "nextcloud/public.php").touch()
        params = self.root / "fastcgi_params"
        params.write_text(
            "fastcgi_param REQUEST_METHOD $request_method;\n"
            "fastcgi_param REQUEST_URI $request_uri;\n"
            "fastcgi_param SCRIPT_NAME $fastcgi_script_name;\n"
            "fastcgi_param QUERY_STRING $query_string;\n")
        php = INSTALL.native_request_uri(r'''
        location ~ \.php(?:$|/) {
            fastcgi_split_path_info ^(.+?\.php)(/.*)$;
            set $path_info $fastcgi_path_info;
            try_files $fastcgi_script_name =404;
            include ''' + INSTALL.nginx_quote(params) + r''';
            fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
            fastcgi_param PATH_INFO $path_info;
            fastcgi_pass php-handler;
        }
''')
        configuration = self.root / "nginx.conf"
        configuration.write_text(f'''
daemon off;
master_process off;
error_log {INSTALL.nginx_quote(self.root / "error.log")};
pid {INSTALL.nginx_quote(self.root / "nginx.pid")};
events {{ worker_connections 32; }}
http {{
    access_log off;
    client_body_temp_path {INSTALL.nginx_quote(self.root / "body")};
    fastcgi_temp_path {INSTALL.nginx_quote(self.root / "fastcgi")};
    upstream php-handler {{ server unix:{self.root}/fcgi.sock; }}
    server {{
        listen unix:{self.http_socket};
        root {INSTALL.nginx_quote(self.root)};
        {INSTALL.public_pdf_location("/spomenar", NATIVE_URI)}
        {php}
    }}
}}
''')
        subprocess.run([NGINX, "-t", "-p", str(self.root), "-c", str(configuration)],
                       check=True, capture_output=True, text=True)
        self.nginx = subprocess.Popen([NGINX, "-p", str(self.root), "-c", str(configuration)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(self.close_nginx)
        for _ in range(100):
            if self.http_socket.exists():
                break
            if self.nginx.poll() is not None:
                self.fail(self.nginx.stderr.read().decode())
            time.sleep(.01)
        self.assertTrue(self.http_socket.exists(), "the isolated nginx listener did not start")

    def close_nginx(self):
        self.nginx.terminate()
        self.nginx.wait(timeout=5)
        self.nginx.stderr.close()

    def close_fcgi(self, thread):
        self.fcgi.shutdown()
        self.fcgi.server_close()
        thread.join()

    def request(self, method="GET", uri="/spomenar/book.pdf", headers=None):
        connection = UnixHttpConnection(self.http_socket)
        try:
            connection.request(method, uri, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_same_book_route_resolves_move_replacement_and_revocation_without_reload(self):
        first = self.request(headers={"Range": "bytes=0-15"})
        self.assertEqual((first[0], len(first[2])), (206, 16))
        moved = self.root / "Moved folder" / "Renamed č.pdf"
        moved.parent.mkdir()
        self.share.file.rename(moved)
        self.share.file = moved
        after_move = self.request(headers={"Range": "bytes=0-15", "If-Range": first[1]["ETag"]})
        self.assertEqual(after_move[0], 206)
        self.assertEqual(after_move[2], first[2])
        self.assertEqual(after_move[1]["ETag"], first[1]["ETag"])
        moved.write_bytes(b"%PDF-2.0\nnew representation\n")
        stale = self.request(headers={"Range": "bytes=0-15", "If-Range": first[1]["ETag"]})
        self.assertEqual(stale[0], 200)
        self.assertNotEqual(stale[1]["ETag"], first[1]["ETag"])
        fresh = self.request(headers={"Range": "bytes=0-15", "If-Range": stale[1]["ETag"]})
        self.assertEqual((fresh[0], len(fresh[2])), (206, 16))
        self.share.revoked = True
        self.assertEqual(self.request(headers={"Range": "bytes=0-15"})[0], 404)
        self.assertEqual(len(self.fcgi.params), 5, "every request reaches the authoritative handler")
        self.assertTrue(all(entry["REQUEST_URI"] == NATIVE_URI for entry in self.fcgi.params))

    def test_head_and_range_headers_reach_native_dav_and_book_arguments_cannot_change_the_share(self):
        head = self.request("HEAD")
        self.assertEqual(head[0], 200)
        self.assertEqual(head[2], b"")
        self.assertEqual(int(head[1]["Content-Length"]), self.share.file.stat().st_size)
        result = self.request(uri="/spomenar/book.pdf?files=another.pdf",
                              headers={"Range": "bytes=5-20", "If-Range": head[1]["ETag"]})
        self.assertEqual((result[0], len(result[2])), (206, 16))
        params = self.fcgi.params[-1]
        self.assertEqual(params["PATH_INFO"], "/dav/files/stable-token")
        self.assertEqual(params["QUERY_STRING"], "")
        self.assertEqual(params["HTTP_RANGE"], "bytes=5-20")
        self.assertEqual(params["HTTP_IF_RANGE"], head[1]["ETag"])
        self.assertEqual(self.request("POST")[0], 405)
        self.assertEqual(len(self.fcgi.params), 2)

    def test_unrelated_native_requests_keep_their_original_encoded_uri_and_arguments(self):
        uri = "/nextcloud/public.php/dav/files/another%20token?x=a%20b"
        self.assertEqual(self.request(uri=uri)[0], 404)
        self.assertEqual(self.fcgi.params[-1]["REQUEST_URI"], uri)
        self.assertEqual(self.fcgi.params[-1]["QUERY_STRING"], "x=a%20b")


if __name__ == "__main__":
    unittest.main()
