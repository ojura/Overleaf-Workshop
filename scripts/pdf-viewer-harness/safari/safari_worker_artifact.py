"""Bounded public worker artifact verification, distinct from executed page evidence."""
import hashlib
import time
from urllib.request import Request, urlopen


def verify_worker(worker, *, open_url=urlopen, now=time.monotonic):
    started = now()
    request = Request(worker.url, headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
    digest, size = hashlib.sha256(), 0
    with open_url(request, timeout=8) as response:
        if response.status != 200 or response.geturl() != worker.url:
            raise RuntimeError('The exact worker artifact did not return HTTP 200 without redirect')
        if response.headers.get('Content-Encoding', 'identity') != 'identity':
            raise RuntimeError('Worker artifact verification requires identity encoding')
        while True:
            if now() - started >= 8:
                raise TimeoutError('Worker artifact verification exceeded eight seconds')
            chunk = response.read1(min(65536, worker.entry.bytes + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > worker.entry.bytes:
                raise RuntimeError('The worker artifact exceeds its expected byte length')
            digest.update(chunk)
    observed = digest.hexdigest()
    return {'evidence': 'fresh-public-artifact', 'url': worker.url, 'bytes': size, 'sha256': observed,
            'expected': {'bytes': worker.entry.bytes, 'sha256': worker.entry.sha256},
            'matched': size == worker.entry.bytes and observed == worker.entry.sha256,
            'elapsedMs': (now() - started) * 1000}
