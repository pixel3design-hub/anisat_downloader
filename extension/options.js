import { api as webext } from './lib/api.js';
const $ = (id) => document.getElementById(id);


async function api(type, extra = {}) {
  const r = await webext.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'errore');
  return r.data;
}

const FEED_PORT = 8787;

const { settings } = await api('state');

$('concurrency').value = settings.concurrency;
$('downloadFolder').value = settings.downloadFolder;
$('refreshMin').value = settings.refreshMin;
$('feedServer').value = settings.feedServer;
$('accountProfile').value = settings.accountProfile || '';
$('importWatched').checked = settings.importWatched !== false;

$('save').addEventListener('click', async () => {
  const patch = {
    concurrency: Math.min(6, Math.max(1, Number($('concurrency').value) || 2)),
    downloadFolder: $('downloadFolder').value.trim(),
    refreshMin: Math.min(720, Math.max(5, Number($('refreshMin').value) || 30)),
    feedServer: $('feedServer').value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8787',
    accountProfile: $('accountProfile').value.trim(),
    importWatched: $('importWatched').checked,
  };
  try {
    await api('settings', { patch });
    $('saved').textContent = 'Salvato ✓';
    setTimeout(() => ($('saved').textContent = ''), 2000);
  } catch (e) {
    $('saved').textContent = `Errore: ${e.message}`;
  }
});

$('checkProfile').addEventListener('click', async () => {
  const el = $('profileStatus');
  const input = $('accountProfile').value.trim();
  el.className = 'status';
  if (!input) {
    el.className = 'status bad';
    el.textContent = 'inserisci il numero o l\'URL del profilo';
    return;
  }
  el.textContent = 'verifico…';
  try {
    const p = await api('accountCheck', { input });
    el.className = 'status ok';
    el.textContent = `${p.name || 'senza nome'} · id ${p.id} · watchlist ${p.watchlist.length} · preferiti ${p.favorites.length}${p.truncated ? ' · lista troncata' : ''}`;
    // salva subito l'id normalizzato: ".../profile/286" e "286" sono lo stesso profilo
    $('accountProfile').value = p.id;
  } catch (e) {
    el.className = 'status bad';
    el.textContent = e.message;
  }
});

$('checkServer').addEventListener('click', async () => {
  const el = $('serverStatus');
  el.className = 'status';
  el.textContent = 'verifico…';
  const base = ($('feedServer').value.trim() || `http://127.0.0.1:${FEED_PORT}`).replace(/\/+$/, '');
  try {
    // /status richiede la password: qui basta sapere che il servizio risponde
    const r = await fetch(`${base}/health`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(String(r.status));
    el.className = 'status ok';
    el.textContent = `attivo · configurazione su ${base}/`;
  } catch {
    el.className = 'status bad';
    el.textContent = 'non raggiungibile: avvia anisat-feed';
  }
});
