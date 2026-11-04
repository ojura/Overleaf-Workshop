"""Native-share preflight and retired adapter checks using only small temporary files."""

from email.utils import formatdate
import contextlib
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "spomenar_install", Path(__file__).with_name("spomenar-install.py"))
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)
NATIVE_URI = "/nextcloud/public.php/dav/files/stable-token"


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


class AdapterRetirementTest(unittest.TestCase):
    def test_native_handler_is_unchanged_without_an_old_adapter(self):
        source = "location ~ php {\n    include fastcgi_params;\n    fastcgi_pass php-handler;\n}\n"
        self.assertEqual(INSTALL.remove_native_request_uri(source), source)

    def test_only_the_exact_old_adapter_is_removed_and_removal_is_idempotent(self):
        native = "location ~ php {\n    include fastcgi_params;\n    fastcgi_pass php-handler;\n}\n"
        old = native.replace(
            "    fastcgi_pass php-handler;",
            "    # Spomenar rewrites to native DAV; other requests keep their original URI.\n"
            "    fastcgi_param REQUEST_URI $spomenar_request_uri;\n"
            "    fastcgi_pass php-handler;")
        result = INSTALL.remove_native_request_uri(old)
        self.assertEqual(result, native)
        self.assertEqual(INSTALL.remove_native_request_uri(result), native)

    def test_unrecognized_references_require_review(self):
        with self.assertRaisesRegex(RuntimeError, "explicit review"):
            INSTALL.remove_native_request_uri("set $spomenar_request_uri /unrecognized;\n")


class PublicationInstallTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="spomenar-install-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.stage = self.root / "stage"
        self.stage.mkdir()
        self.source = self.stage / "site"
        self.source.mkdir()
        (self.source / "index.html").write_text("new viewer")
        (self.source / "config.json").write_text('{"edition":"stale build seed"}')
        self.web = self.root / "www"
        self.site = self.web / "spomenar"
        self.site.mkdir(parents=True)
        (self.site / "index.html").write_text("old viewer")
        self.catalog = self.root / "publication" / "catalog"
        self.catalog.mkdir(parents=True)
        self.config = self.catalog / "config.json"
        self.config.write_text('{"publicationGeneration":7,"edition":"current"}')
        self.config_before = self.config.read_bytes()
        nginx = self.root / "nginx"
        (nginx / "conf.d").mkdir(parents=True)
        (nginx / "snippets").mkdir()
        self.nginx_main = nginx / "nginx.conf"
        self.nginx_main.write_text("http { include " + str(nginx / "conf.d/*.conf") + "; }\n")
        self.nginx_site = nginx / "conf.d/nextcloud.conf"
        self.nginx_site.write_text("server {\n    server_name example.test;\n    ssl_certificate fixture;\n}\n")
        self.nginx_snippet = nginx / "snippets/spomenar.conf"
        self.nginx_snippet.write_text("# previous routes\n")
        self.old_site = self.nginx_site.read_bytes()
        self.old_snippet = self.nginx_snippet.read_bytes()
        settings = {
            "url": "https://example.test/spomenar/", "apply": True,
            "shareUrl": "https://example.test/nextcloud/s/token",
            "webRoot": str(self.web), "publicationRoot": str(self.catalog.parent),
            "nginxMain": str(self.nginx_main), "nginxSite": str(self.nginx_site),
            "nginxSnippet": str(self.nginx_snippet),
        }
        (self.stage / "deployment.json").write_text(json.dumps(settings))
        self.reloads = 0

    def invoke(self, *, activation_failure=False, cleanup_failure=False, reporting_failure=False):
        original_remove = shutil.rmtree
        original_print = print

        def command(arguments, **_options):
            if arguments == ["systemctl", "reload", "nginx"]:
                self.reloads += 1
                if activation_failure and self.reloads == 1:
                    raise subprocess.CalledProcessError(1, arguments)

        def remove(path, *args, **kwargs):
            if cleanup_failure and Path(path).name.startswith(".spomenar-previous-"):
                (Path(path) / "index.html").unlink()
                raise OSError("fixture interrupted backup cleanup")
            return original_remove(path, *args, **kwargs)

        def report(*args, **kwargs):
            if reporting_failure and args and str(args[0]).startswith("Published "):
                raise BrokenPipeError("fixture closed reporting pipe")
            return original_print(*args, **kwargs)

        # Native transport and the exact static locations have their own real
        # HTTP/nginx fixtures; this exercises main's filesystem commit boundary.
        with mock.patch.object(INSTALL, "__file__", str(self.stage / "install.py")), \
                mock.patch.object(INSTALL, "public_pdf", return_value={"bytes": 100, "validator": {"header": "ETag", "value": '"pdf"'}}), \
                mock.patch.object(INSTALL, "publication_routes", return_value="# fixed publication aliases\n"), \
                mock.patch.object(INSTALL, "command", side_effect=command), \
                mock.patch.object(INSTALL.shutil, "rmtree", side_effect=remove), \
                mock.patch("builtins.print", side_effect=report), contextlib.redirect_stdout(io.StringIO()):
            INSTALL.main()

    def test_activation_preserves_catalog_and_omits_stale_asset_seed(self):
        self.invoke()
        self.assertEqual((self.site / "index.html").read_text(), "new viewer")
        self.assertFalse((self.site / "config.json").exists())
        self.assertEqual(self.config.read_bytes(), self.config_before)
        self.assertEqual(self.reloads, 1)
        self.assertFalse(list(self.web.glob(".spomenar-*")))

    def test_failed_activation_restores_old_site_and_both_nginx_files(self):
        with self.assertRaises(subprocess.CalledProcessError):
            self.invoke(activation_failure=True)
        self.assertEqual((self.site / "index.html").read_text(), "old viewer")
        self.assertEqual(self.nginx_site.read_bytes(), self.old_site)
        self.assertEqual(self.nginx_snippet.read_bytes(), self.old_snippet)
        self.assertEqual(self.config.read_bytes(), self.config_before)
        self.assertEqual(self.reloads, 2)
        self.assertFalse(list(self.web.glob(".spomenar-*")))

    def test_post_commit_cleanup_failure_keeps_the_activated_site(self):
        with self.assertRaisesRegex(OSError, "backup cleanup"):
            self.invoke(cleanup_failure=True)
        self.assertEqual((self.site / "index.html").read_text(), "new viewer")
        self.assertEqual(self.reloads, 1)
        self.assertEqual(self.config.read_bytes(), self.config_before)

    def test_post_commit_reporting_failure_keeps_the_activated_site(self):
        with self.assertRaises(BrokenPipeError):
            self.invoke(reporting_failure=True)
        self.assertEqual((self.site / "index.html").read_text(), "new viewer")
        self.assertEqual(self.reloads, 1)
        self.assertEqual(self.config.read_bytes(), self.config_before)


if __name__ == "__main__":
    unittest.main()
