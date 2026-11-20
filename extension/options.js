import { api as webext } from './lib/api.js';
const $ = (id) => document.getElementById(id);

import { pickDir, getDir, clearDir, permission } from './lib/folder.js';

async function api(type, extra = {}) {
  const r = await webext.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'errore');
  return r.data;
}

const FEED_PORT = 8787;

const { settings } = await api('state');

async function showFolder() {
  const el = $('folderStatus');
  const handle = await getDir();
  if (!handle) {
    el.className = 'status';
    el.textContent = 'nessuna cartella scelta (si usa Download del browser)';
    return;
  }
  const p = await permission(handle);
  el.className = `status ${p === 'granted' ? 'ok' : 'bad'}`;
  el.textContent = `${handle.name} · permesso ${p === 'granted' ? 'attivo' : 'da rinnovare dal popup'}`;
}

// Firefox non ha la File System Access API: resta la cartella Download del browser
const canPickFolder = typeof window.showDirectoryPicker === 'function';
if (!canPickFolder) {
  $('pickFolder').disabled = true;
  $('forgetFolder').disabled = true;
  $('folderStatus').textContent = 'questo browser non permette di scegliere la cartella: si usa Download predefinito';
} else {
  await showFolder();
}

$('pickFolder').addEventListener('click', async () => {
  try {
    await pickDir();
    await showFolder();
  } catch (e) {
    $('folderStatus').className = 'status bad';
    $('folderStatus').textContent = `errore: ${e.message}`;
  }
});

$('forgetFolder').addEventListener('click', async () => {
  await clearDir();
  await showFolder();
});

$('concurrency').value = settings.concurrency;
$('downloadFolder').value = settings.downloadFolder;
$('refreshMin').value = settings.refreshMin;
$('feedServer').value = settings.feedServer;

$('save').addEventListener('click', async () => {
  const patch = {
    concurrency: Math.min(6, Math.max(1, Number($('concurrency').value) || 2)),
    downloadFolder: $('downloadFolder').value.trim(),
    refreshMin: Math.min(720, Math.max(5, Number($('refreshMin').value) || 30)),
    feedServer: $('feedServer').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787',
  };
  try {
    await api('settings', { patch });
    $('saved').textContent = 'Salvato ✓';
    setTimeout(() => ($('saved').textContent = ''), 2000);
  } catch (e) {
    $('saved').textContent = `Errore: ${e.message}`;
  }
});

$('checkServer').addEventListener('click', async () => {
  const el = $('serverStatus');
  el.className = 'status';
  el.textContent = 'verifico…';
  const base = ($('feedServer').value.trim() || `http://127.0.0.1:${FEED_PORT}`).replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/status`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(String(r.status));
    const s = await r.json();
    el.className = 'status ok';
    el.textContent = `attivo · ${s.items} item · ${(s.bytes / 1024).toFixed(1)} KB · ${s.path}`;
  } catch {
    el.className = 'status bad';
    el.textContent = 'non raggiungibile: avvia anisat-feed';
  }
});
