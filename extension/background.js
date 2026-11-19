// Service worker: unico cervello dell'estensione.
// - refresh serie/episodi dal sito
// - coda di download nativa (chrome.downloads) con URL ri-risolte al bisogno
// - feed RSS scritto in <Download>/AniSatDownloader/feed.xml

import * as site from './sites/animesaturn.js';
import { buildFeed } from './lib/feed.js';

const DEFAULTS = {
  concurrency: 2,
  refreshMin: 30,
  feedEnabled: true,
  feedFolder: 'AniSatDownloader',
};

const FEED_FILE = 'feed.xml';
const feedDownloads = new Set();
let lastFeedXml = null;

// --- storage -------------------------------------------------------------

async function store() {
  const s = await chrome.storage.local.get(['series', 'episodes', 'seen', 'cadence', 'queue', 'settings', 'news']);
  return {
    series: s.series || {},
    episodes: s.episodes || {},
    seen: s.seen || {},
    cadence: s.cadence || {},
    queue: s.queue || [],
    news: s.news || {},
    settings: { ...DEFAULTS, ...(s.settings || {}) },
  };
}

const put = (patch) => chrome.storage.local.set(patch);

// --- serie --------------------------------------------------------------

export async function refreshSeries(slug) {
  const st = await store();
  const known = st.series[slug];
  const full = await site.series(known?.url || site.seriesUrl(slug));
  const { episodes, ...meta } = full;
  st.series[slug] = { ...known, ...meta, addedAt: known?.addedAt || Date.now(), favorite: true };
  st.episodes[slug] = episodes;

  // primo contatto: ricava la data dell'ultimo episodio uscito (granularità giorno)
  if (!st.series[slug].lastRelease && episodes.length) {
    const ts = await site.episodeDate(episodes[episodes.length - 1].url).catch(() => null);
    if (ts) {
      st.series[slug].lastRelease = ts;
      st.cadence[slug] = [...(st.cadence[slug] || []), ts].sort((a, b) => a - b);
    }
  }
  st.news[slug] = 0;

  await put({ series: st.series, episodes: st.episodes, cadence: st.cadence, news: st.news });
  return st.series[slug];
}

async function addSeries(url) {
  const slug = site.slugOf(url);
  if (!slug) throw new Error('URL non riconosciuta: incolla la pagina di una serie');
  await refreshSeries(slug);
  await writeFeed();
  return store();
}

async function removeSeries(slug) {
  const st = await store();
  delete st.series[slug];
  delete st.episodes[slug];
  delete st.seen[slug];
  delete st.cadence[slug];
  delete st.news[slug];
  st.queue = st.queue.filter((q) => q.slug !== slug);
  await put({ series: st.series, episodes: st.episodes, seen: st.seen, cadence: st.cadence, news: st.news, queue: st.queue });
  await writeFeed();
}

// --- polling RSS --------------------------------------------------------

async function poll() {
  const st = await store();
  if (!Object.keys(st.series).length) return { updated: 0 };

  let items = [];
  try {
    items = await site.episodesFeed();
  } catch {
    // sito irraggiungibile: si riprova al prossimo giro
  }

  const toRefresh = new Set();
  for (const it of items) {
    const s = st.series[it.slug];
    if (!s) continue;
    const cad = (st.cadence[it.slug] || []).filter((x) => x !== it.pubDate);
    cad.push(it.pubDate);
    cad.sort((a, b) => a - b);
    st.cadence[it.slug] = cad.slice(-10);
    s.lastRelease = Math.max(s.lastRelease || 0, it.pubDate);
    if (it.n > (s.airedEps || 0)) toRefresh.add(it.slug);
  }

  await put({ series: st.series, cadence: st.cadence });

  let updated = 0;
  for (const slug of toRefresh) {
    try {
      const before = st.series[slug]?.airedEps || 0;
      const s = await refreshSeries(slug);
      if (s.airedEps > before) {
        const st2 = await store();
        st2.news[slug] = s.airedEps - before;
        await put({ news: st2.news });
        updated++;
      }
    } catch {
      // una serie che fallisce non blocca le altre
    }
  }

  await writeFeed();
  await updateBadge();
  return { updated };
}

async function updateBadge() {
  const st = await store();
  const n = Object.values(st.news).reduce((a, b) => a + (b || 0), 0);
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
}

// --- feed ---------------------------------------------------------------

async function feedXml(st) {
  const catalog = Object.values(st.series)
    .filter((s) => s.favorite)
    .map((s) => ({
      slug: s.slug,
      title: s.title,
      poster: s.poster,
      airedEps: s.airedEps || 0,
      totalEps: s.totalEps || s.airedEps || 0,
      lastRelease: s.lastRelease || null,
      cadence: st.cadence[s.slug] || [],
    }));
  if (!catalog.length) return null;
  const needsUpcoming = catalog.some((s) => !s.airedEps);
  const upcoming = needsUpcoming ? await site.upcoming().catch(() => ({})) : {};
  return buildFeed({ catalog, upcoming });
}

async function writeFeed(force = false) {
  const st = await store();
  if (!st.settings.feedEnabled) return null;
  let xml;
  try {
    xml = await feedXml(st);
  } catch {
    return null;
  }
  if (!xml) return null;
  if (!force && xml === lastFeedXml) return null;
  lastFeedXml = xml;

  const b64 = btoa(xml); // feed.js produce solo ASCII
  const id = await chrome.downloads.download({
    url: `data:application/rss+xml;base64,${b64}`,
    filename: `${st.settings.feedFolder}/${FEED_FILE}`,
    conflictAction: 'overwrite',
    saveAs: false,
  });
  feedDownloads.add(id);
  return id;
}

// --- coda download ------------------------------------------------------

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'serie';
}

function fileName(series, n) {
  const base = safeName(series?.title || series?.slug || 'serie');
  return `${base}/${base} - Ep ${String(n).padStart(2, '0')}.mp4`;
}

async function enqueue(slug, ns) {
  const st = await store();
  const eps = st.episodes[slug] || [];
  for (const n of ns) {
    const ep = eps.find((e) => e.n === Number(n));
    if (!ep) continue;
    if (st.queue.some((q) => q.slug === slug && q.n === Number(n) && q.state !== 'error')) continue;
    st.queue.push({ slug, n: Number(n), epUrl: ep.url, state: 'queued', addedAt: Date.now() });
  }
  await put({ queue: st.queue });
  await pump();
}

async function pump() {
  const st = await store();
  // giro precedente interrotto prima di avere un downloadId: torna in coda
  for (const q of st.queue) if (q.state === 'downloading' && !q.downloadId) q.state = 'queued';
  let active = st.queue.filter((q) => q.state === 'downloading').length;
  for (const q of st.queue) {
    if (active >= st.settings.concurrency) break;
    if (q.state !== 'queued') continue;
    active++;
    q.state = 'downloading';
    q.error = null;
    try {
      const r = await site.resolveStream(q.epUrl);
      if (!r.url) throw new Error('sorgente HLS non supportata');
      q.url = r.url;
      q.expiresAt = r.expiresAt;
      q.downloadId = await chrome.downloads.download({
        url: r.url,
        filename: fileName(st.series[q.slug], q.n),
        conflictAction: 'uniquify',
        saveAs: false,
      });
    } catch (e) {
      q.state = 'error';
      q.error = String(e?.message || e);
    }
    await put({ queue: st.queue });
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;

  if (feedDownloads.has(delta.id)) {
    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
      feedDownloads.delete(delta.id);
      chrome.downloads.erase({ id: delta.id }); // niente voce nel pannello download
    }
    return;
  }

  const st = await store();
  const q = st.queue.find((x) => x.downloadId === delta.id);
  if (!q) return;
  if (delta.state.current === 'complete') q.state = 'done';
  else if (delta.state.current === 'interrupted') {
    q.state = 'error';
    q.error = 'download interrotto';
  }
  await put({ queue: st.queue });
  pump();
});

// --- lista file ---------------------------------------------------------

async function exportList(slug, ns) {
  const st = await store();
  const series = st.series[slug];
  const eps = (st.episodes[slug] || []).filter((e) => !ns?.length || ns.includes(e.n)).sort((a, b) => a.n - b.n);
  const lines = [];
  for (const ep of eps) {
    try {
      const r = await site.resolveStream(ep.url);
      if (!r.url) continue;
      lines.push(`${r.url}\n  out=${fileName(series, ep.n)}`);
    } catch {
      lines.push(`# ep ${ep.n}: URL non risolvibile (${ep.url})`);
    }
  }
  if (!lines.length) throw new Error('nessun URL risolto');
  const text = lines.join('\n') + '\n';
  const name = `AniSatDownloader/${safeName(series?.title || slug)}-list.txt`;
  await chrome.downloads.download({
    url: `data:text/plain;base64,${btoa(text)}`,
    filename: name,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  return { count: lines.length, name };
}

// --- messaggi -----------------------------------------------------------

const handlers = {
  state: async () => store(),
  search: ({ q }) => site.search(q),
  add: ({ url }) => addSeries(url),
  remove: ({ slug }) => removeSeries(slug),
  refresh: async ({ slug }) => {
    if (slug) return refreshSeries(slug);
    const st = await store();
    return Promise.all(Object.keys(st.series).map(refreshSeries));
  },
  poll: () => poll(),
  download: ({ slug, ns }) => enqueue(slug, ns),
  retry: async ({ slug, n }) => {
    const st = await store();
    const q = st.queue.find((x) => x.slug === slug && x.n === n);
    if (q) {
      q.state = 'queued';
      q.error = null;
      await put({ queue: st.queue });
    }
    return pump();
  },
  cancel: async ({ id }) => {
    const st = await store();
    const dlId = Number(id);
    const q = st.queue.find((x) => x.downloadId === dlId);
    if (q?.downloadId) chrome.downloads.cancel(q.downloadId);
    st.queue = st.queue.filter((x) => x.downloadId !== dlId);
    await put({ queue: st.queue });
  },
  clearQueue: async () => put({ queue: [] }),
  seen: async ({ slug, n, value }) => {
    const st = await store();
    const list = new Set(st.seen[slug] || []);
    value ? list.add(n) : list.delete(n);
    st.seen[slug] = [...list].sort((a, b) => a - b);
    st.news[slug] = 0;
    await put({ seen: st.seen, news: st.news });
    await updateBadge();
  },
  exportList: ({ slug, ns }) => exportList(slug, ns),
  writeFeed: async () => {
    await writeFeed(true);
    return { ok: true };
  },
  settings: async ({ patch }) => {
    const st = await store();
    const settings = { ...st.settings, ...patch };
    await put({ settings });
    await chrome.alarms.create('poll', { periodInMinutes: settings.refreshMin });
    return settings;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) {
    reply({ error: `comando sconosciuto: ${msg?.type}` });
    return false;
  }
  Promise.resolve(fn(msg))
    .then((r) => reply({ ok: true, data: r }))
    .catch((e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

// --- ciclo di vita ------------------------------------------------------

async function boot() {
  const st = await store();
  await chrome.alarms.create('poll', { periodInMinutes: st.settings.refreshMin });
  await updateBadge();
  await pump(); // coda rimasta in sospeso dopo un riavvio del service worker
}

chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') poll();
});
