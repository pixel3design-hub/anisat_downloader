// Service worker: unico cervello dell'estensione.
// - refresh serie/episodi dal sito (una o più stagioni)
// - coda di download nativa (downloads API) con URL ri-risolte al bisogno
// - feed RSS inviato al servizio anisat-feed (POST /feed), che lo salva in ~/.anisatrss/feed.rss

import { api as webext } from './lib/api.js';
import * as site from './sites/animesaturn.js';
import { buildFeed } from './lib/feed.js';

const DEFAULTS = {
  concurrency: 2,
  refreshMin: 30,
  downloadFolder: 'AnimeSaturn',
  feedServer: 'http://127.0.0.1:8787',
  accountProfile: '',
  importWatched: true,
};

let lastFeedXml = null;

// --- storage -------------------------------------------------------------

async function store() {
  const s = await webext.storage.local.get(['series', 'episodes', 'seen', 'cadence', 'queue', 'settings', 'news', 'feedState', 'serviceOk', 'account']);
  return {
    series: s.series || {},
    episodes: s.episodes || {},
    seen: s.seen || {},
    cadence: s.cadence || {},
    queue: s.queue || [],
    news: s.news || {},
    feedState: s.feedState || { ok: null, at: null, bytes: 0 },
    serviceOk: s.serviceOk ?? null,
    account: s.account || null,
    settings: { ...DEFAULTS, ...(s.settings || {}) },
  };
}

const put = (patch) => webext.storage.local.set(patch);

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

async function addSeries(slugs) {
  const list = Array.isArray(slugs) ? slugs : [slugs];
  for (const item of list) {
    const slug = site.slugOf(item) || item;
    if (!slug) throw new Error('URL non riconosciuta: incolla la pagina di una serie');
    await refreshSeries(slug);
  }
  const push = await pushFeed({ quiet: true });
  return { push };
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
  await pushFeed({ quiet: true });
}

// --- profilo pubblico (watchlist, preferiti, calendario) -----------------

// Legge il profilo pubblico configurato e salva l'elenco. Solo su clic.
async function accountImport({ input } = {}) {
  const st = await store();
  const id = site.profileId(input || st.settings.accountProfile);
  if (!id) throw new Error('profilo non configurato: inserisci il tuo profilo AnimeSaturn nelle opzioni');
  const p = await site.profile(id);
  const account = {
    ...(st.account || {}),
    id,
    name: p.name,
    at: Date.now(),
    favorites: p.favorites,
    watchlist: p.watchlist,
    counts: p.counts,
    truncated: p.truncated,
    calendar: st.account?.calendar || [],
  };
  await put({ account });
  // il calendario serve subito: senza, il primo feed userebbe solo la stima
  await calendarRefresh().catch(() => {});
  return (await store()).account;
}

// Aggiunge ai preferiti le serie scelte (o tutte quelle del profilo).
async function accountAdd({ slugs } = {}) {
  const st = await store();
  const rows = st.account?.watchlist || [];
  const chosen = Array.isArray(slugs) && slugs.length ? slugs : rows.map((w) => w.slug);
  if (!chosen.length) throw new Error('nessuna serie da aggiungere: importa prima il profilo');

  const bySlug = new Map(rows.map((w) => [w.slug, w]));
  const seen = { ...st.seen };
  let added = 0;

  for (const slug of chosen) {
    const info = await refreshSeries(slug);
    added++;
    // il sito dà solo il conteggio dei visti: 1..watched, e solo se non hai già segni tuoi
    const watched = bySlug.get(slug)?.watched || 0;
    if (st.settings.importWatched && watched > 0 && !(seen[slug] || []).length) {
      const upto = Math.min(watched, info?.airedEps || watched);
      seen[slug] = Array.from({ length: upto }, (_, i) => i + 1);
    }
  }

  await put({ seen });
  const push = await pushFeed({ quiet: true });
  return { added, push };
}

// Uscite della settimana + ultime uscite dal feed del sito, per le serie seguite.
async function calendarRefresh() {
  const st = await store();
  if (!st.account?.id) throw new Error('profilo non configurato: importa prima il profilo');

  const entries = await site.calendar();
  const followed = new Set(Object.keys(st.series));
  let recent = [];
  try {
    const feed = await site.episodesFeed();
    recent = feed
      .filter((x) => followed.has(x.slug))
      .sort((a, b) => b.pubDate - a.pubDate)
      .slice(0, 20)
      .map((x) => ({ slug: x.slug, n: x.n, pubDate: x.pubDate, link: x.link }));
  } catch {
    // feed del sito irraggiungibile: restano le voci precedenti
    recent = st.account.recent || [];
  }

  const account = { ...st.account, calendar: entries, calendarAt: Date.now(), recent };
  await put({ account });
  await pushFeed({ quiet: true });
  return account;
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

  // il calendario si rinnova allo stesso giro dei preferiti (niente timer nuovi)
  if (st.account?.id) await calendarRefresh().catch(() => {});

  await pushFeed({ quiet: true });
  await updateBadge();
  return { updated };
}

async function updateBadge() {
  const st = await store();
  const n = Object.values(st.news).reduce((a, b) => a + (b || 0), 0);
  await webext.action.setBadgeText({ text: n ? String(n) : '' });
  await webext.action.setBadgeBackgroundColor({ color: '#7c3aed' });
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
      episodes: st.episodes[s.slug] || [],
    }));
  if (!catalog.length) return null;
  const needsUpcoming = catalog.some((s) => !s.airedEps);
  const upcoming = needsUpcoming ? await site.upcoming().catch(() => ({})) : {};

  // orari reali del calendario, quando la serie c'è
  const calendar = {};
  for (const e of st.account?.calendar || []) {
    const ts = site.calendarTs(e);
    if (!ts) continue;
    (calendar[e.slug] ||= []).push({ n: e.ep, ts });
  }

  return buildFeed({ catalog, upcoming, calendar });
}

// Invia il feed al servizio anisat-feed, che lo salva in ~/.anisatrss/feed.rss.
// Niente download: se il server non c'è, l'errore ha serverDown=true e la UI chiede cosa fare.
async function pushFeed({ quiet = false, force = false } = {}) {
  const st = await store();
  const xml = await feedXml(st);
  if (!xml) return { skipped: 'nessuna serie nei preferiti' };
  if (!force && xml === lastFeedXml) return { unchanged: true };

  const base = String(st.settings.feedServer || DEFAULTS.feedServer).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/feed`, {
      method: 'POST',
      body: xml,
      headers: { 'content-type': 'text/plain;charset=UTF-8' }, // niente preflight
    });
  } catch (e) {
    const err = new Error(`server RSS non raggiungibile su ${base}`);
    err.serverDown = true;
    await put({ feedState: { ok: false, at: Date.now(), bytes: xml.length, error: err.message } });
    if (quiet) return { serverDown: true, error: err.message, xml };
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`il server ha risposto ${res.status}`);
    err.serverDown = true;
    await put({ feedState: { ok: false, at: Date.now(), bytes: xml.length, error: err.message } });
    if (quiet) return { serverDown: true, error: err.message, xml };
    throw err;
  }

  lastFeedXml = xml;
  const info = await res.json().catch(() => ({}));
  await put({ feedState: { ok: true, at: Date.now(), bytes: info.bytes ?? xml.length, path: info.path || '' } });
  return { ok: true, bytes: xml.length, path: info.path || '', url: `${base}/feed.xml` };
}

// Solo su richiesta esplicita dell'utente (server assente).
async function saveFeedFile() {
  const st = await store();
  const xml = await feedXml(st);
  if (!xml) throw new Error('nessuna serie nei preferiti');
  await webext.downloads.download({
    url: `data:application/rss+xml;base64,${btoa(xml)}`,
    filename: 'feed.rss',
    conflictAction: 'overwrite',
    saveAs: false,
  });
  return { bytes: xml.length };
}

// --- coda download ------------------------------------------------------

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'serie';
}

function fileName(series, n, folder = DEFAULTS.downloadFolder) {
  const base = safeName(series?.title || series?.slug || 'serie');
  const prefix = safeName(folder).replace(/^\/+|\/+$/g, '');
  const path = `${base}/${base} - Ep ${String(n).padStart(2, '0')}.mp4`;
  return prefix ? `${prefix}/${path}` : path;
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

  const server = String(st.settings.feedServer || DEFAULTS.feedServer).replace(/\/+$/, '');
  let active = st.queue.filter((q) => q.state === 'downloading').length;
  const running = [];

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
      const rel = fileName(st.series[q.slug], q.n, st.settings.downloadFolder);

      // il servizio scrive nella sua cartella: nessun dialogo "salva con nome"
      const sent = await sendToServer(server, q, rel, r.url);
      if (sent) {
        q.via = 'server';
        q.progress = 0;
      } else {
        q.via = 'browser';
        q.downloadId = await webext.downloads.download({
          url: r.url,
          filename: rel,
          conflictAction: 'uniquify',
          saveAs: false,
        });
      }
    } catch (e) {
      q.state = 'error';
      q.error = String(e?.message || e);
    }
    await put({ queue: st.queue });
  }

  await Promise.allSettled(running);
  pollJobs();
}

async function sendToServer(server, q, rel, url) {
  try {
    const r = await fetch(`${server}/download`, {
      method: 'POST',
      body: JSON.stringify({ id: `${q.slug}#${q.n}`, url, path: rel }),
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
    });
    if (!r.ok) return false;
    await put({ serviceOk: true });
    return true;
  } catch {
    await put({ serviceOk: false });
    return false;
  }
}

// il servizio espone lo stato dei download in /jobs: qui si riporta nella coda
async function pollJobs() {
  const st = await store();
  const active = st.queue.filter((q) => q.via === 'server' && q.state === 'downloading');
  if (!active.length) return;

  const server = String(st.settings.feedServer || DEFAULTS.feedServer).replace(/\/+$/, '');
  try {
    const r = await fetch(`${server}/jobs`, { cache: 'no-store' });
    const { jobs = [] } = await r.json();
    const byId = new Map(jobs.map((j) => [j.id, j]));
    for (const q of active) {
      const job = byId.get(`${q.slug}#${q.n}`);
      if (!job) continue;
      q.progress = job.total ? Math.min(99, Math.round((job.done / job.total) * 100)) : (q.progress || 0);
      if (job.state === 'done') {
        q.state = 'done';
        q.progress = 100;
        q.bytes = job.done;
      } else if (job.state === 'error') {
        q.state = 'error';
        q.error = job.error || 'errore nel servizio';
      }
    }
    await put({ queue: st.queue });
  } catch {
    // servizio sparito: la coda resta "in corso" finché non torna il polling successivo
  }

  const still = (await store()).queue.some((q) => q.via === 'server' && q.state === 'downloading');
  if (still) setTimeout(pollJobs, 4000);
}


webext.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state) return;

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
      lines.push(`${r.url}\n  out=${fileName(series, ep.n, st.settings.downloadFolder)}`);
    } catch {
      lines.push(`# ep ${ep.n}: URL non risolvibile (${ep.url})`);
    }
  }
  if (!lines.length) throw new Error('nessun URL risolto');
  const text = lines.join('\n') + '\n';
  const name = `${st.settings.downloadFolder || DEFAULTS.downloadFolder}/${safeName(series?.title || slug)}-list.txt`;
  await webext.downloads.download({
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
  seasons: ({ url }) => site.seasons(url),
  add: ({ slugs, url }) => addSeries(slugs || url),
  remove: ({ slug }) => removeSeries(slug),
  refresh: async ({ slug }) => {
    if (slug) return refreshSeries(slug);
    const st = await store();
    return Promise.all(Object.keys(st.series).map(refreshSeries));
  },
  poll: () => poll(),
  accountCheck: ({ input } = {}) => site.profile(input),
  accountImport: (msg) => accountImport(msg),
  accountAdd: (msg) => accountAdd(msg),
  calendarRefresh: () => calendarRefresh(),
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
    if (q?.downloadId) webext.downloads.cancel(q.downloadId);
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
  pushFeed: ({ force } = {}) => pushFeed({ force }),
  saveFeed: () => saveFeedFile(),
  settings: async ({ patch }) => {
    const st = await store();
    const settings = { ...st.settings, ...patch };
    await put({ settings });
    await webext.alarms.create('poll', { periodInMinutes: settings.refreshMin });
    return settings;
  },
};

webext.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) {
    reply({ error: `comando sconosciuto: ${msg?.type}` });
    return false;
  }
  Promise.resolve(fn(msg))
    .then((r) => reply({ ok: true, data: r }))
    .catch((e) =>
      reply({
        ok: false,
        error: String(e?.message || e),
        serverDown: Boolean(e?.serverDown),
        xml: e?.serverDown ? e.xml : undefined,
      }),
    );
  return true;
});

// --- ciclo di vita ------------------------------------------------------

async function boot() {
  const st = await store();
  await webext.alarms.create('poll', { periodInMinutes: st.settings.refreshMin });
  await updateBadge();
  await pump(); // coda rimasta in sospeso dopo un riavvio del service worker
}

webext.runtime.onInstalled.addListener(boot);
webext.runtime.onStartup.addListener(boot);

webext.alarms.onAlarm.addListener((a) => {
  if (a.name === 'poll') poll();
});
