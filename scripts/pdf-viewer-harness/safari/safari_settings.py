"""Validated run inputs and package assets shared by the Safari tools."""
import hashlib
import json
import pathlib
import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit, urlunsplit

ASSETS = pathlib.Path(__file__).parent.resolve()
REPOSITORY = ASSETS.parents[2]
PREFIX = re.compile(r'^[A-Za-z0-9_-]{1,100}$')
SHA256 = re.compile(r'^[a-f0-9]{64}$')


def prefix(value):
    if not isinstance(value, str) or not PREFIX.fullmatch(value):
        raise ValueError('Use a plain prefix with at most 100 letters, digits, hyphens or underscores')
    return value


def short_page_pair(value, *, page_count=None):
    if not isinstance(value, list) or len(value) != 2 or \
            any(type(page) is not int or not 1 <= page <= 2 ** 53 - 1 for page in value) or \
            value[0] == value[1]:
        raise ValueError('Short scenario pages must be two distinct positive integers supported by the browser')
    if page_count is not None and any(page > page_count for page in value):
        raise ValueError('Short scenario pages exceed the document page count')
    return list(value)


def read_json(filename, limit=65536):
    filename = pathlib.Path(filename)
    if filename.stat().st_size > limit:
        raise ValueError('Configuration exceeds its size limit')
    return json.loads(filename.read_text())


def absolute_url(value):
    if not isinstance(value, str):
        raise ValueError('Expected an absolute HTTPS URL')
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('Expected an absolute HTTPS URL without credentials or a fragment')
    return value


@dataclass(frozen=True)
class Document:
    page_url: str
    entry_url: str
    pdf_url: str
    sha256: str
    bytes: int
    pages: int

    @classmethod
    def from_mapping(cls, value):
        if not isinstance(value, dict) or set(value) != {'pageUrl', 'entryUrl', 'pdfUrl', 'sha256', 'bytes', 'pages'}:
            raise ValueError('Document settings must contain pageUrl, entryUrl, pdfUrl, sha256, bytes and pages')
        urls = [absolute_url(value[key]) for key in ('pageUrl', 'entryUrl', 'pdfUrl')]
        origin = urlsplit(urls[0])[:2]
        if any(urlsplit(url)[:2] != origin for url in urls[1:]):
            raise ValueError('The entry and PDF must belong to the selected page origin')
        if not urlsplit(urls[0]).path.endswith('/'):
            raise ValueError('The selected reader URL must end with a slash')
        if not isinstance(value['sha256'], str) or not SHA256.fullmatch(value['sha256']):
            raise ValueError('Expected the PDF SHA-256 as 64 lowercase hexadecimal characters')
        if any(type(value[key]) is not int or value[key] <= 0 for key in ('bytes', 'pages')):
            raise ValueError('PDF byte length and page count must be positive integers')
        return cls(*urls, value['sha256'], value['bytes'], value['pages'])

    @property
    def origin(self):
        url = urlsplit(self.page_url)
        return urlunsplit((url.scheme, url.netloc, '', '', ''))

    @property
    def page_path(self):
        return urlsplit(self.page_url).path

    @property
    def pdf_path(self):
        return urlsplit(self.pdf_url).path

    def owns_page(self, url):
        if not isinstance(url, str):
            return False
        return urlsplit(url)._replace(fragment='').geturl() == self.page_url

    def network_kind(self, url):
        if not isinstance(url, str):
            return None
        parsed = urlsplit(url)
        if parsed[:2] != urlsplit(self.page_url)[:2]:
            return None
        if parsed._replace(fragment='').geturl() == self.pdf_url:
            return 'pdf'
        if parsed.path.startswith(urlsplit(urljoin(self.page_url, 'previews/')).path):
            return 'preview'
        if parsed.path in (self.page_path + 'config.json', self.page_path + 'status.json'):
            return 'config'
        if parsed.path.startswith(self.page_path):
            return 'site'
        return None

    def browser(self):
        return {'pageUrl': self.page_url, 'entryUrl': self.entry_url, 'pdfUrl': self.pdf_url,
                'sha256': self.sha256, 'bytes': self.bytes, 'pages': self.pages}


@dataclass(frozen=True)
class Entry:
    sha256: str
    bytes: int

    @classmethod
    def expected(cls, *, filename=None, sha256=None, byte_count=None, maximum=1024 * 1024):
        if filename is not None:
            if sha256 is not None or byte_count is not None:
                raise ValueError('Choose --entry-file or --entry-sha with --entry-bytes')
            source = pathlib.Path(filename)
            if not 0 < source.stat().st_size <= maximum:
                raise ValueError('The expected source file exceeds its explicit byte limit')
            data = source.read_bytes()
            return cls(hashlib.sha256(data).hexdigest(), len(data))
        if not isinstance(sha256, str) or not SHA256.fullmatch(sha256) \
                or type(byte_count) is not int or not 0 < byte_count <= maximum:
            raise ValueError('Supply --entry-file or a valid --entry-sha and --entry-bytes pair')
        return cls(sha256, byte_count)


@dataclass(frozen=True)
class Worker:
    url: str
    entry: Entry

    @classmethod
    def expected(cls, url, *, filename=None, sha256=None, byte_count=None):
        return cls(absolute_url(url), Entry.expected(filename=filename, sha256=sha256,
                                                    byte_count=byte_count, maximum=8 * 1024 * 1024))


@dataclass(frozen=True)
class Settings:
    document: Document
    entry: Entry
    work: pathlib.Path
    device_config: pathlib.Path | None = None
    worker: Worker | None = None

    @classmethod
    def from_args(cls, args):
        if not args.work_dir or not args.document_config:
            raise ValueError('Live operations require --work-dir and --document-config')
        work = pathlib.Path(args.work_dir).expanduser().resolve()
        if work == REPOSITORY or work.is_relative_to(REPOSITORY):
            raise ValueError('Keep runtime receipts and pairing data outside the repository')
        document = Document.from_mapping(read_json(args.document_config))
        entry = Entry.expected(filename=args.entry_file, sha256=args.entry_sha, byte_count=args.entry_bytes)
        device = pathlib.Path(args.device_config).expanduser().resolve() if args.device_config else None
        if device and (device == REPOSITORY or device.is_relative_to(REPOSITORY)):
            raise ValueError('Private device settings must remain outside the repository')
        worker = None
        if any(getattr(args, name, None) is not None for name in ('worker_url', 'worker_file', 'worker_sha', 'worker_bytes')):
            worker = Worker.expected(args.worker_url, filename=args.worker_file,
                                     sha256=args.worker_sha, byte_count=args.worker_bytes)
            if urlsplit(worker.url)[:2] != urlsplit(document.page_url)[:2]:
                raise ValueError('The worker artifact must belong to the selected page origin')
        return cls(document, entry, work, device, worker)

    def prepare_work(self):
        self.work.mkdir(parents=True, exist_ok=True, mode=0o700)


def add_arguments(parser):
    parser.add_argument('--execute', action='store_true', help='Allow the explicitly requested live operation')
    parser.add_argument('--work-dir', help='External directory for owner commands and runtime artifacts')
    parser.add_argument('--document-config', help='JSON containing the exact public reader and PDF identity')
    parser.add_argument('--device-config', help='External JSON with udid and pair_record; never committed')
    parser.add_argument('--entry-file', help='Local built JavaScript entry whose bytes must be executing')
    parser.add_argument('--entry-sha', help='Expected executing entry SHA-256')
    parser.add_argument('--entry-bytes', type=int, help='Expected executing entry byte length')
    add_worker_arguments(parser)


def add_worker_arguments(parser):
    parser.add_argument('--worker-url', help='Exact public worker artifact URL, verified separately from executed page code')
    parser.add_argument('--worker-file', help='Expected worker source file, at most 8 MiB')
    parser.add_argument('--worker-sha', help='Expected worker artifact SHA-256')
    parser.add_argument('--worker-bytes', type=int, help='Expected worker artifact byte length')


def load_browser_source(filename):
    if filename not in {'sustained.js', 'release-guard.js', 'sidecar-active.js', 'sidecar-finish.js', 'manual-observe.js'}:
        raise ValueError('Unknown maintained browser probe')
    source = (ASSETS / filename).read_text()
    for module in ('scene-ready.mjs', 'photo-evidence.mjs', 'payload-observation.mjs', 'awake-idle.mjs'):
        marker = '// @include ' + module
        count = source.count(marker)
        if count > 1:
            raise ValueError('A browser probe may include each helper only once')
        if count:
            helper = re.sub(r'^export ', '', (ASSETS / module).read_text(), flags=re.MULTILINE)
            source = source.replace(marker, helper)
    return source
