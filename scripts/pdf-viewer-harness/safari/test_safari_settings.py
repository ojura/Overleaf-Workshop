"""Portable input and bounded artifact evidence; all reads use owned local fixtures."""
import hashlib
import io
import pathlib
import tempfile
import unittest
from unittest import mock

import safari_settings as settings
from safari_worker_artifact import verify_worker
from test_support import DOCUMENT


class SettingsTests(unittest.TestCase):
    def test_exact_reader_and_pdf_queries_are_identity_not_substring_matches(self):
        self.assertTrue(DOCUMENT.owns_page(DOCUMENT.page_url + '#page=46'))
        self.assertFalse(DOCUMENT.owns_page(DOCUMENT.page_url + '?other=true'))
        self.assertEqual(DOCUMENT.network_kind(DOCUMENT.pdf_url), 'pdf')
        self.assertNotEqual(DOCUMENT.network_kind(DOCUMENT.pdf_url + '?different=true'), 'pdf')

    def test_entry_and_worker_have_distinct_explicit_source_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = pathlib.Path(directory) / 'worker.mjs'
            filename.write_bytes(b'x' * (1800 * 1024))
            with self.assertRaises(ValueError):
                settings.Entry.expected(filename=filename)
            worker = settings.Worker.expected(DOCUMENT.page_url + 'assets/worker.mjs', filename=filename)
            self.assertEqual(worker.entry.bytes, 1800 * 1024)
        for value in (True, 0, -1, 9 * 1024 * 1024):
            with self.assertRaises(ValueError):
                settings.Worker.expected(DOCUMENT.page_url, sha256='a' * 64, byte_count=value)

    def test_helper_assembly_uses_one_canonical_module_and_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            assets = pathlib.Path(directory)
            (assets / 'payload-observation.mjs').write_text('export class Observations {}\n')
            (assets / 'awake-idle.mjs').write_text('export function idle() {}\n')
            source = assets / 'sustained.js'
            source.write_text('// @include payload-observation.mjs\n// @include awake-idle.mjs\n')
            with mock.patch.object(settings, 'ASSETS', assets):
                assembled = settings.load_browser_source('sustained.js')
                self.assertIn('class Observations', assembled)
                self.assertIn('function idle', assembled)
                self.assertNotIn('export ', assembled)
                source.write_text('// @include awake-idle.mjs\n// @include awake-idle.mjs')
                with self.assertRaises(ValueError):
                    settings.load_browser_source('sustained.js')

    def test_worker_artifact_result_names_fetched_bytes_separately(self):
        body = b'const worker = true;'
        worker = settings.Worker.expected(DOCUMENT.page_url + 'assets/worker.mjs',
            sha256=hashlib.sha256(body).hexdigest(), byte_count=len(body))
        response = io.BytesIO(body)
        response.status, response.headers = 200, {}
        response.geturl = lambda: worker.url
        opened = mock.Mock(return_value=response)
        result = verify_worker(worker, open_url=opened)
        self.assertTrue(result['matched'])
        self.assertEqual(result['evidence'], 'fresh-public-artifact')
        self.assertEqual(opened.call_args.args[0].get_header('Cache-control'), 'no-cache')

    def test_worker_artifact_does_not_accept_redirect_encoding_or_overlong_body(self):
        worker = settings.Worker.expected(DOCUMENT.page_url + 'assets/worker.mjs', sha256='a' * 64, byte_count=1)
        for url, headers, data in ((worker.url + '?redirect', {}, b'x'),
                                   (worker.url, {'Content-Encoding': 'gzip'}, b'x'),
                                   (worker.url, {}, b'xx')):
            response = io.BytesIO(data)
            response.status, response.headers = 200, headers
            response.geturl = lambda url=url: url
            with self.subTest(url=url, headers=headers, data=data), self.assertRaises(RuntimeError):
                verify_worker(worker, open_url=lambda *args, response=response, **kwargs: response)
