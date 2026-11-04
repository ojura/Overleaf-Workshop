#!/usr/bin/env python3
"""Resolve the public Nextcloud file, validate nginx, and publish this site's assets."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote, urlsplit


def command(args, **options):
    return subprocess.run(args, check=True, **options)


def nginx_quote(value):
    value = str(value)
    if any(character in value for character in ('\n', '\r', '$')):
        raise ValueError('Unsupported character in nginx path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def public_pdf(settings):
    # Credentials stay inside this short PHP process. Only the named public share is read.
    php = r'''
try {
    require $argv[1];
    $prefix = $CONFIG["dbtableprefix"] ?? "oc_";
    if (!preg_match("/^[a-zA-Z0-9_]+$/", $prefix)) { throw new RuntimeException("Unexpected table prefix"); }
    if ($CONFIG["dbtype"] !== "mysql") { throw new RuntimeException("Unsupported database driver"); }
    $dsn = "mysql:host=".$CONFIG["dbhost"].";dbname=".$CONFIG["dbname"].";charset=utf8mb4";
    $db = new PDO($dsn, $CONFIG["dbuser"], $CONFIG["dbpassword"], [
        PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC
    ]);
    $sql = "SELECT s.share_type,s.permissions,s.expiration,(s.password IS NOT NULL AND LENGTH(s.password)>0) AS protected,f.path,f.encrypted,st.id AS storage_id FROM ".$prefix."share s JOIN ".$prefix."filecache f ON f.fileid=s.file_source JOIN ".$prefix."storages st ON st.numeric_id=f.storage WHERE s.token=?";
    $query = $db->prepare($sql); $query->execute([$argv[2]]); $rows = $query->fetchAll();
    if (count($rows) !== 1) { throw new RuntimeException("Expected exactly one public share"); }
    $row = $rows[0];
    if ((int)$row["share_type"] !== 3 || !((int)$row["permissions"] & 1) || $row["protected"]
        || ($row["expiration"] && strtotime($row["expiration"]) <= time())) {
        throw new RuntimeException("The share is not an active public readable link");
    }
    if ($row["encrypted"] || !str_starts_with($row["storage_id"], "local::")) {
        throw new RuntimeException("The public PDF needs unencrypted local storage for direct ranges");
    }
    $base = realpath(substr($row["storage_id"], strlen("local::")));
    $file = $base ? realpath($base."/".$row["path"]) : false;
    if (!$base || !$file || !str_starts_with($file, $base."/") || !is_file($file)
        || file_get_contents($file, false, null, 0, 5) !== "%PDF-") {
        throw new RuntimeException("The public share does not resolve to a local PDF");
    }
    echo json_encode(["file"=>$file,"bytes"=>filesize($file),"modified"=>filemtime($file)], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    fwrite(STDERR, "Cannot resolve public PDF: ".$error->getMessage().PHP_EOL);
    exit(1);
}
'''
    token = unquote(urlsplit(settings['shareUrl']).path.rstrip('/').rsplit('/', 1)[1])
    result = command(
        ['php', '-d', 'zend.exception_ignore_args=1', '-r', php,
         str(Path(settings['nextcloudRoot']) / 'config/config.php'), token],
        text=True, capture_output=True,
    )
    return json.loads(result.stdout)


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
    worker = re.search(r'^\s*user\s+([^;\s]+)', main_text, re.MULTILINE)
    if not worker:
        raise RuntimeError('Cannot identify the nginx worker user')
    command(['runuser', '-u', worker.group(1), '--', 'test', '-r', pdf['file']])

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

# Only this already-public file is exposed; Nextcloud's data directory remains private.
location = {prefix}/book.pdf {{
    alias {nginx_quote(pdf['file'])};
    types {{ }}
    default_type application/pdf;
    sendfile on;
    gzip off;
    etag on;
    open_file_cache off;
    add_header Cache-Control "public, no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}}

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
    desired = add_include(original_main.decode(), nginx_snippet, address.hostname)
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
        print('Published ' + settings['url'] + ' with a direct byte-range PDF alias.', flush=True)
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
