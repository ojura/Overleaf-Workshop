#!/usr/bin/env python3
"""Validate the native public Nextcloud route and nginx, then publish the site's assets."""
from email.utils import parsedate_to_datetime
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import quote, unquote, urlsplit, urlunsplit


def command(args, **options):
    return subprocess.run(args, check=True, **options)


def nginx_quote(value):
    value = str(value)
    if any(character in value for character in ('\n', '\r', '$')):
        raise ValueError('Unsupported character in nginx path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def public_pdf_url(settings):
    """The public DAV token root follows the share's current node, including renames."""
    share = urlsplit(settings['shareUrl'])
    site = urlsplit(settings['url'])
    if (share.scheme not in ('http', 'https') or share.username or share.password
            or share.query or share.fragment
            or (share.scheme, share.hostname, share.port) != (site.scheme, site.hostname, site.port)):
        raise ValueError('The public share must use the standalone site origin')
    parts = share.path.rstrip('/').split('/')
    if len(parts) < 3 or parts[-2] != 's':
        raise ValueError('Expected a Nextcloud public share URL ending in /s/TOKEN')
    decoded = [unquote(part) for part in parts[1:]]
    if any(not part or part in ('.', '..') or re.search(r'[/\x00-\x20\x7f]', part) for part in decoded):
        raise ValueError('Invalid public share path')
    webroot = '/'.join(parts[:-2]).removesuffix('/index.php')
    path = webroot + '/public.php/dav/files/' + quote(decoded[-1], safe='')
    return urlunsplit((share.scheme, share.netloc, path, '', ''))


def public_pdf(settings):
    """Observe metadata and at most sixteen PDF bytes through Nextcloud's own share guards."""
    url = public_pdf_url(settings)
    address = urlsplit(url)
    connection_type = http.client.HTTPSConnection if address.scheme == 'https' else http.client.HTTPConnection

    def headers(response):
        if response.getheader('Content-Encoding', 'identity').lower() != 'identity':
            raise RuntimeError('The public PDF response must use identity encoding')
        if response.getheader('Content-Type', '').split(';', 1)[0].strip().lower() != 'application/pdf':
            raise RuntimeError('The public share did not return a PDF response')
        length = response.getheader('Content-Length', '')
        if not re.fullmatch(r'[0-9]+', length):
            raise RuntimeError('The public PDF response needs an exact Content-Length')
        return int(length)

    def request(method, extra=None):
        connection = connection_type(address.hostname, address.port, timeout=20)
        try:
            connection.request(method, address.path, headers={
                'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', **(extra or {}),
            })
            return connection, connection.getresponse()
        except Exception:
            connection.close()
            raise

    connection, response = request('HEAD')
    try:
        if response.status != 200:
            raise RuntimeError(f'The native public PDF HEAD returned HTTP {response.status}')
        size = headers(response)
        if size < 5 or size > 2 ** 53 - 1:
            raise RuntimeError('The public PDF has an invalid byte length')
        etag = response.getheader('ETag', '')
        modified = response.getheader('Last-Modified')
        if re.fullmatch(r'"[^"\x00-\x20\x7f]*"', etag):
            validator = {'header': 'ETag', 'value': etag}
        elif modified and parsedate_to_datetime(modified) is not None:
            validator = {'header': 'Last-Modified', 'value': modified}
        else:
            raise RuntimeError('The public PDF needs a strong ETag or Last-Modified validator')
    finally:
        response.close()
        connection.close()

    end = min(15, size - 1)
    connection, response = request('GET', {'Range': f'bytes=0-{end}', 'If-Range': validator['value']})
    try:
        # Inspect status and bounds before reading: a redirect or full-file response has no body read.
        if response.status != 206:
            raise RuntimeError(f'The native public PDF range returned HTTP {response.status}, expected 206')
        if (headers(response) != end + 1
                or response.getheader('Content-Range') != f'bytes 0-{end}/{size}'
                or response.getheader(validator['header']) != validator['value']):
            raise RuntimeError('The native public PDF range disagrees with its observed representation')
        sample = response.read(end + 2)
        if len(sample) != end + 1 or not sample.startswith(b'%PDF-'):
            raise RuntimeError('The public share did not return the exact requested PDF bytes')
    finally:
        response.close()
        connection.close()
    return {'url': url, 'bytes': size, 'validator': validator, 'lastModified': modified}


def public_pdf_location(prefix, native_uri):
    """Reuse Nextcloud's PHP/DAV handler; nginx keeps the original request URI across rewrites."""
    return f'''# Resolve the current share on every request; no file path or inode is retained here.
set $spomenar_request_uri $request_uri;
location = {prefix}/book.pdf {{
    if ($request_method !~ "^(GET|HEAD)$") {{ return 405; }}
    set $spomenar_request_uri {nginx_quote(native_uri)};
    rewrite ^ $spomenar_request_uri? last;
}}
'''


def native_request_uri(source):
    """One adapter in the existing PHP location supplies the rewritten DAV URI to Nextcloud."""
    directive = 'fastcgi_param REQUEST_URI $spomenar_request_uri;'
    anchor = re.compile(r'^([ \t]*)fastcgi_pass[ \t]+php-handler;[ \t]*$', re.MULTILINE)
    matches = list(anchor.finditer(source))
    if len(matches) != 1:
        raise RuntimeError('Cannot identify the existing Nextcloud PHP handler unambiguously')
    match = matches[0]
    if directive in source:
        if source.count(directive) != 1 or not source[:match.start()].rstrip().endswith(directive):
            raise RuntimeError('The canonical request URI adapter is not in its expected PHP location')
        return source
    indent = match.group(1)
    adapter = (indent + '# Spomenar rewrites to native DAV; other requests keep their original URI.\n'
               + indent + directive + '\n')
    return source[:match.start()] + adapter + source[match.start():]


def add_include(source, include, hostname):
    directive = 'include ' + nginx_quote(include) + ';'
    if directive in source:
        if source.count(directive) != 1:
            raise RuntimeError('The site snippet is included more than once')
        return source
    # Steffy's TLS host has server_name directly before its certificate directives.
    # Refuse a different layout instead of guessing which shared server block to change.
    anchor = re.compile(
        r'(^[ \t]*server_name\s+' + re.escape(hostname)
        + r';[ \t]*\n)(?=[ \t]*ssl_certificate\s)', re.MULTILINE
    )
    if len(anchor.findall(source)) != 1:
        raise RuntimeError('Cannot identify the existing TLS server unambiguously')
    return anchor.sub(lambda match: match.group(1) + '    ' + directive + '\n', source)


def absolute_includes(source, directory):
    return re.sub(
        r'\binclude\s+([^;\s]+)\s*;',
        lambda match: match.group(0) if match.group(1).startswith(('/', '"'))
        else 'include ' + nginx_quote(directory / match.group(1)) + ';',
        source,
    )


def write_atomic(filename, content, mode=0o644):
    filename = Path(filename)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=filename.parent, prefix='.' + filename.name, delete=False) as output:
            temporary = Path(output.name)
            output.write(content if isinstance(content, bytes) else content.encode())
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, filename)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main():
    stage = Path(__file__).resolve().parent
    settings = json.loads((stage / 'deployment.json').read_text())
    address = urlsplit(settings['url'])
    prefix = address.path.rstrip('/')
    if not prefix.startswith('/') or any(part in ('', '.', '..') for part in prefix[1:].split('/')):
        raise RuntimeError('Invalid site path')
    web_root = Path(settings['webRoot'])
    site = web_root / prefix[1:]
    preview_site = site.with_name(site.name + '-previews')
    nginx_main = Path(settings['nginxMain'])
    nginx_site = Path(settings['nginxSite'])
    nginx_snippet = Path(settings['nginxSnippet'])
    original_main = nginx_site.read_bytes()
    original_snippet = nginx_snippet.read_bytes() if nginx_snippet.exists() else None
    site_mode = nginx_site.stat().st_mode & 0o777
    main_text = nginx_main.read_text()
    pdf = public_pdf(settings)

    csp = (
        "default-src 'self'; base-uri 'self'; connect-src 'self'; "
        "script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
        "worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data: blob:; "
        "object-src 'none'; frame-ancestors 'self'"
    )
    snippet = f'''# Public standalone LARICS viewer. Generated by scripts/deploy-spomenar.mjs.
location = {prefix} {{
    return 301 {prefix}/$is_args$args;
}}

{public_pdf_location(prefix, urlsplit(pdf['url']).path)}

# Generated previews survive replacement of the standalone viewer's static directory.
location ^~ {prefix}/previews/ {{
    alias {nginx_quote(str(preview_site) + '/')};
    autoindex off;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "{csp}" always;
}}

location ^~ {prefix}/ {{
    root {nginx_quote(web_root)};
    index index.html;
    try_files $uri $uri/ =404;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "{csp}" always;
}}
'''
    (stage / 'spomenar.conf').write_text(snippet)
    desired = native_request_uri(add_include(original_main.decode(), nginx_snippet, address.hostname))
    test_site = desired.replace(nginx_quote(nginx_snippet), nginx_quote(stage / 'spomenar.conf'))
    test_site = absolute_includes(test_site, nginx_main.parent)
    (stage / 'nextcloud-check.conf').write_text(test_site)
    glob = str(nginx_site.parent / '*.conf')
    includes = '\n'.join(
        'include ' + nginx_quote(stage / 'nextcloud-check.conf' if file == nginx_site else file) + ';'
        for file in sorted(nginx_site.parent.glob('*.conf'))
    )
    pattern = re.compile(r'\binclude\s+' + re.escape(glob) + r'\s*;')
    if len(pattern.findall(main_text)) != 1:
        raise RuntimeError('Cannot replace the nginx site include in the temporary check')
    (stage / 'nginx-check.conf').write_text(
        absolute_includes(pattern.sub(lambda _: includes, main_text), nginx_main.parent)
    )
    command(['nginx', '-t', '-c', str(stage / 'nginx-check.conf')])
    print(json.dumps({'mode': 'deploy' if settings['apply'] else 'check', 'url': settings['url'],
                      'pdf': pdf, 'nginx': 'valid'}, ensure_ascii=False), flush=True)
    if not settings['apply']:
        return

    source = stage / 'site'
    if not (source / 'index.html').is_file():
        raise RuntimeError('The staged viewer has no index.html')
    for file in source.rglob('*'):
        if file.is_symlink() or file.name == 'book.pdf':
            raise RuntimeError('The static build must not contain symlinks or a PDF copy')
    if preview_site.is_symlink() or (preview_site.exists() and not preview_site.is_dir()):
        raise RuntimeError('The preview destination is not an ordinary directory')
    preview_site.mkdir(mode=0o755, parents=True, exist_ok=True)
    next_site = Path(tempfile.mkdtemp(prefix='.' + site.name + '-next-', dir=site.parent))
    previous = None
    published = False
    changed = False
    try:
        shutil.copytree(source, next_site, dirs_exist_ok=True)
        for file in [next_site, *next_site.rglob('*')]:
            file.chmod(0o755 if file.is_dir() else 0o644)
        changed = True
        write_atomic(nginx_snippet, snippet)
        write_atomic(nginx_site, desired, site_mode)
        command(['nginx', '-t'])
        if site.exists():
            if not site.is_dir() or site.is_symlink():
                raise RuntimeError('The site destination is not an ordinary directory')
            previous = Path(tempfile.mkdtemp(prefix='.' + site.name + '-previous-', dir=site.parent))
            previous.rmdir()
            os.replace(site, previous)
        os.replace(next_site, site)
        published = True
        command(['systemctl', 'reload', 'nginx'])
        if previous:
            shutil.rmtree(previous)
        print('Published ' + settings['url'] + ' with native Nextcloud share resolution for every PDF request.', flush=True)
    except Exception:
        if published:
            shutil.rmtree(site)
        if previous and previous.exists():
            os.replace(previous, site)
        if changed:
            write_atomic(nginx_site, original_main, site_mode)
            if original_snippet is None:
                nginx_snippet.unlink(missing_ok=True)
            else:
                write_atomic(nginx_snippet, original_snippet)
            command(['nginx', '-t'])
            command(['systemctl', 'reload', 'nginx'])
        raise
    finally:
        if next_site.exists():
            shutil.rmtree(next_site)


if __name__ == '__main__':
    main()
