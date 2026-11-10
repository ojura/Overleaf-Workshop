import fs from 'node:fs';

// Browser expressions stay inert until the host invokes the returned function.
export function loadBrowserSource(filename) {
  if (!['sustained.js', 'release-guard.js', 'sidecar-active.js', 'sidecar-finish.js', 'manual-observe.js'].includes(filename)) {
    throw new Error('Unknown Safari browser source');
  }
  let source = fs.readFileSync(new URL(filename, import.meta.url), 'utf8');
  for (const [name, label] of [['surface-observation.mjs', 'surface observation'], ['scene-ready.mjs', 'scene readiness'], ['photo-evidence.mjs', 'photo evidence'], ['payload-observation.mjs', 'portable payload observer'], ['awake-idle.mjs', 'awake idle observer']]) {
    const marker = '  // @include ' + name;
    if (!source.includes(marker)) continue;
    if (source.split(marker).length !== 2) throw new Error('Ambiguous browser include');
    const helper = fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8').replace(/^export /gm, '').trim();
    source = source.replace(marker, '  // BEGIN ' + label + '\n'
      + helper.split('\n').map(line => '  ' + line).join('\n') + '\n  // END ' + label);
  }
  return source;
}
