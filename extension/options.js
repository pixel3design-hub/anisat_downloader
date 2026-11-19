const $ = (id) => document.getElementById(id);

async function api(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r?.ok) throw new Error(r?.error || 'errore');
  return r.data;
}

const { settings } = await api('state');
$('concurrency').value = settings.concurrency;
$('refreshMin').value = settings.refreshMin;
$('feedFolder').value = settings.feedFolder;
$('feedEnabled').checked = settings.feedEnabled;

$('save').addEventListener('click', async () => {
  await api('settings', {
    patch: {
      concurrency: Math.min(6, Math.max(1, Number($('concurrency').value) || 2)),
      refreshMin: Math.min(720, Math.max(5, Number($('refreshMin').value) || 30)),
      feedFolder: $('feedFolder').value.trim() || 'AniSatDownloader',
      feedEnabled: $('feedEnabled').checked,
    },
  });
  $('save').textContent = 'Salvato ✓';
  setTimeout(() => ($('save').textContent = 'Salva'), 1500);
});
