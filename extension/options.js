const $ = (id) => document.getElementById(id);

async function api(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'errore');
  return r.data;
}

const FEED_PORT = 8787;

const { settings } = await api('state');
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
