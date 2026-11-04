#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));

// Machine-specific settings for the existing Steffy site and authenticated root channel.
// Every PDF request uses this stable public share's native Nextcloud DAV route.
const target = Object.freeze({
  host: 'steffy',
  url: 'https://cloud.larics.fer.hr/spomenar/',
  shareUrl: 'https://cloud.larics.fer.hr/nextcloud/s/spomenar-2026',
  webRoot: '/var/www/html',
  nginxMain: '/etc/nginx/nginx.conf',
  nginxSite: '/etc/nginx/conf.d/nextcloud.conf',
  nginxSnippet: '/etc/nginx/snippets/spomenar.conf',
  rootListener: '/home/juraj/claude-skills/sudo-listener/sudo_listener.py',
});

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const sshOptions = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const rsyncShell = 'ssh -o BatchMode=yes -o ConnectTimeout=10';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (capture && result.stderr) { process.stderr.write(result.stderr); }
  if (result.error) { throw result.error; }
  if (result.status !== 0) {
    if (capture && result.stdout) { process.stdout.write(result.stdout); }
    throw new Error(command + ' exited with ' + result.status);
  }
  return result.stdout ?? '';
}

const remote = command => run('ssh', [...sshOptions, target.host, command], true);

function checkAssets(directory) {
  if (!fs.statSync(path.join(directory, 'index.html')).isFile()) {
    throw new Error('Build the standalone viewer before deploying it.');
  }
  let bytes = 0;
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) { throw new Error('Static build contains a symlink: ' + filename); }
      if (entry.isDirectory()) { visit(filename); }
      else if (entry.isFile()) {
        if (entry.name === 'book.pdf') { throw new Error('The existing server PDF must not be copied into the build.'); }
        bytes += fs.statSync(filename).size;
      } else { throw new Error('Unexpected static asset: ' + filename); }
    }
  }
  visit(directory);
  // The PDF is 1.61 GB; its bytes must stay in Nextcloud's existing storage.
  if (bytes > 128 * 1024 * 1024) { throw new Error('Static assets unexpectedly exceed 128 MiB.'); }
  return bytes;
}

async function main() {
  let apply = false;
  let build = path.join(repo, 'dist', 'spomenar');
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--deploy') { apply = true; }
    else if (arg === '--check') { apply = false; }
    else if (arg === '--build-dir' && args[index + 1]) { build = path.resolve(args[++index]); }
    else if (arg === '--help') {
      console.log('node scripts/deploy-spomenar.mjs [--check | --deploy] [--build-dir DIRECTORY]');
      console.log('--check verifies native public PDF metadata/ranges and a temporary nginx configuration.');
      console.log('--deploy also publishes the built assets and gracefully reloads nginx.');
      return;
    } else { throw new Error('Unknown or incomplete argument: ' + arg); }
  }
  const assetBytes = apply ? checkAssets(build) : undefined;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'spomenar-deploy-'));
  let staging;
  try {
    fs.writeFileSync(path.join(temporary, 'deployment.json'), JSON.stringify({ ...target, apply }) + '\n');
    fs.copyFileSync(path.join(repo, 'scripts', 'spomenar-install.py'), path.join(temporary, 'install.py'));
    staging = remote('mktemp -d /tmp/spomenar-deploy.XXXXXXXX').trim();
    if (!/^\/tmp\/spomenar-deploy\.[a-zA-Z0-9]+$/.test(staging)) {
      throw new Error('Unexpected remote staging directory.');
    }
    run('rsync', ['-a', '-e', rsyncShell, '--', temporary + '/', target.host + ':' + staging + '/']);
    if (apply) {
      run('rsync', ['-a', '-e', rsyncShell, '--', build + '/', target.host + ':' + staging + '/site/']);
      console.log('Uploading ' + assetBytes + ' bytes of static assets; the PDF stays in place.');
    }
    const rootCommand = ['python3', path.posix.join(staging, 'install.py')].map(quote).join(' ');
    const command = ['python3', target.rootListener, 'run', rootCommand].map(quote).join(' ');
    process.stdout.write(remote(command));
  } finally {
    if (staging && /^\/tmp\/spomenar-deploy\.[a-zA-Z0-9]+$/.test(staging)) {
      remote('rm -rf -- ' + quote(staging));
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
