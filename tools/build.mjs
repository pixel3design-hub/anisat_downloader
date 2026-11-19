// Prepara i pacchetti dell'estensione per i vari browser.
//   dist/chrome/      → Chrome, Chromium, Edge, Brave, Opera (service worker)
//   dist/firefox/     → Firefox (event page + gecko id)
//   dist/*.zip        → pronti da caricare nei vari store
//
// Uso: node tools/build.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'extension');
const dist = join(root, 'dist');

const base = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
const version = base.version;

function copyTree(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    // tests e fixture non servono nei pacchetti
    filter: (p) => !p.includes(`${join('extension', 'tests')}`) && !p.includes('_metadata'),
  });
}

// Chrome/Chromium/Edge/Brave: manifest invariato (service worker + WithHostAccess).
copyTree(join(dist, 'chrome'));

// Firefox: event page al posto del service worker, permesso DNR classico, id gecko.
copyTree(join(dist, 'firefox'));
const ff = structuredClone(base);
ff.background = { scripts: ['background.js'], type: 'module' };
ff.permissions = base.permissions.map((p) => (p === 'declarativeNetRequestWithHostAccess' ? 'declarativeNetRequest' : p));
// Firefox vuole author come stringa (Chrome accetta l'oggetto con la mail)
ff.author = 'Cristiano Gariboldo <social@pixel3design.it>';
ff.browser_specific_settings = {
  gecko: {
    id: 'anisat-downloader@pixel3design.it',
    // data_collection_permissions esiste da Firefox 140
    strict_min_version: '142.0',
    data_collection_permissions: { required: ['none'] },
  },
};
writeFileSync(join(dist, 'firefox', 'manifest.json'), JSON.stringify(ff, null, 2) + '\n');

// zip pronti per gli store (serve il comando `zip`)
function zip(dir, name) {
  const out = join(dist, name);
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.'], { cwd: dir });
  return out;
}

const chromeZip = zip(join(dist, 'chrome'), `anisat-extension-chrome-${version}.zip`);
const firefoxZip = zip(join(dist, 'firefox'), `anisat-extension-firefox-${version}.zip`);

console.log(`estensione ${version}`);
console.log(`  chrome/chromium/edge/brave/opera → ${chromeZip}`);
console.log(`  firefox                          → ${firefoxZip}`);
