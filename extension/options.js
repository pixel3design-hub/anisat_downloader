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
$('feedFolder').value = settings.feedFolder;
$('feedEnabled').checked = settings.feedEnabled;

$('save').addEventListener('click', async () => {
  const patch = {
    concurrency: Math.min(6, Math.max(1, Number($('concurrency').value) || 2)),
    downloadFolder: $('downloadFolder').value.trim(),
    refreshMin: Math.min(720, Math.max(5, Number($('refreshMin').value) || 30)),
    feedFolder: $('feedFolder').value.trim() || 'AniSatDownloader',
    feedEnabled: $('feedEnabled').checked,
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
  try {
    const r = await fetch(`http://127.0.0.1:${FEED_PORT}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    const ok = r.ok;
    el.className = `status ${ok ? 'ok' : 'bad'}`;
    el.textContent = ok ? `attivo (HTTP ${r.status})` : `risponde con HTTP ${r.status}`;
  } catch {
    el.className = 'status bad';
    el.textContent = 'non raggiungibile: avvia anisat-feed';
  }
});
