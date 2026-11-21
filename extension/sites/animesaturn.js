// Adapter del sito. Unico punto che conosce il markup di animesaturn:
// se il sito cambia, si tocca solo questo file.

import { decodeEntities, firstMatch, jsonLd, xorDecode } from '../lib/html.js';

export const SITE = 'https://www.animesaturn.net';
const PLAY = 'https://play.saturncdn.net';

export const siteId = 'animesaturn';

export function matches(url) {
  return /^https?:\/\/(www\.)?animesaturn\.(net|com)\//i.test(url);
}

export function slugOf(url) {
  const m = /\/anime\/([^/?#]+)/.exec(String(url));
  return m ? m[1] : null;
}

export function seriesUrl(slug) {
  return `${SITE}/anime/${slug}`;
}

export function episodeUrl(slug, n) {
  // la pagina con il player è /anime/<slug>/ep-N: /episode/<slug>/ep-N è solo una scheda senza video
  return `${SITE}/anime/${slug}/ep-${n}`;
}

async function get(url, as = 'text') {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${url}`);
  return as === 'json' ? r.json() : r.text();
}

const MONTHS = {
  gennaio: 0, febbraio: 1, marzo: 2, aprile: 3, maggio: 4, giugno: 5,
  luglio: 6, agosto: 7, settembre: 8, ottobre: 9, novembre: 10, dicembre: 11,
};

// "03 Ottobre 2026" -> epoch ms (mezzanotte locale)
export function parseItDate(s) {
  const m = /(\d{1,2})\s+([A-Za-zÀ-ù]+)\s+(\d{4})/.exec(String(s));
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  const d = new Date(Number(m[3]), month, Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

// --- ricerca -------------------------------------------------------------

export async function search(q) {
  const j = await get(`${SITE}/api/search?q=${encodeURIComponent(q)}`, 'json');
  return (j.results || []).map((x) => ({
    slug: slugOf(x.url),
    title: x.title,
    url: SITE + x.url,
    poster: x.poster || '',
    year: x.year || '',
    episodes: Number(x.episodes) || null,
    status: x.status?.label || '',
  }));
}

// --- pagina serie --------------------------------------------------------

export async function series(url) {
  const html = await get(url);
  const slug = slugOf(url);
  if (!slug) throw new Error(`URL serie non riconosciuta: ${url}`);

  const ld = jsonLd(html).find((x) => x['@type'] === 'TVSeries') || {};

  const byNumber = new Map();
  for (const m of html.matchAll(/href="\/episode\/([^/"]+)\/(ep-(\d+))"/g)) {
    byNumber.set(Number(m[3]), { n: Number(m[3]), url: episodeUrl(slug, Number(m[3])) });
  }
  const episodes = [...byNumber.values()].sort((a, b) => a.n - b.n);

  const statusRegion = firstMatch(/Stato<\/span>([\s\S]{0,400})/, html) || '';
  const status = (firstMatch(/<span[^>]*>([^<]+)<\/span>/, statusRegion) || '').trim();

  const totalEps =
    Number(ld.numberOfEpisodes) ||
    Number(firstMatch(/Episodi<\/span>\s*<span class="font-medium">(\d+)/, html)) ||
    episodes.length;

  const airedEps =
    Number(firstMatch(/Episodi\s*<span[^>]*>\((\d+)\)<\/span>/, html)) || episodes.length;

  return {
    slug,
    url: seriesUrl(slug),
    title: ld.name || decodeEntities(firstMatch(/<meta property="og:title" content="([^"]*)"/, html) || slug),
    poster: ld.image || firstMatch(/<meta property="og:image" content="([^"]*)"/, html) || '',
    description: (ld.description || '').trim(),
    status,
    totalEps,
    airedEps,
    episodes,
    updatedAt: Date.now(),
  };
}

// data di uscita (giorno) dell'episodio, dal JSON-LD TVEpisode
export async function episodeDate(url) {
  const html = await get(url);
  const ld = jsonLd(html).find((x) => x['@type'] === 'TVEpisode') || {};
  const d = Date.parse(ld.datePublished || '');
  return Number.isNaN(d) ? null : d;
}

// --- film: risoluzione URL diretto --------------------------------------

export async function resolveStream(url) {
  const page = String(url).replace('/episode/', '/anime/'); // il player vive solo su /anime/
  const html = await get(page);
  const raw = firstMatch(/x-data="watchPage\((\{[\s\S]*?\})\)"/, html);
  if (!raw) throw new Error('payload watchPage non trovato (markup cambiato?)');

  const data = JSON.parse(decodeEntities(raw));
  const server = (data.servers || []).find((s) => s && s.link) || {};
  const link = server.link || data.initialVideoUrl;
  if (!link) throw new Error('nessun server video disponibile');

  const u = new URL(link);
  const id = u.pathname.split('/').filter(Boolean).pop();
  const token = u.searchParams.get('token') || '';
  const expires = u.searchParams.get('expires') || '';

  const r = await fetch(
    `${PLAY}/embed/${id}/playlist?token=${encodeURIComponent(token)}&expires=${expires}`,
    { credentials: 'omit', cache: 'no-store' },
  );
  const j = await r.json().catch(() => ({}));
  if (!j.d) {
    throw new Error(
      j.ok === false
        ? 'playlist rifiutata: manca il Referer (regola declarativeNetRequest non attiva)'
        : 'playlist vuota',
    );
  }

  const src = xorDecode(j.d, token);
  if (!/^https?:\/\//.test(src)) throw new Error('decodifica playlist fallita');
  const expiresAt = expires ? Number(expires) * 1000 : Date.now() + 11 * 3600e3;

  return { url: /\.m3u8(\?|$)/i.test(src) ? null : src, hls: /\.m3u8(\?|$)/i.test(src) ? src : null, expiresAt };
}

// --- prossime uscite ----------------------------------------------------

// { slug: epochMs } per le serie non ancora iniziate
export async function upcoming() {
  const html = await get(`${SITE}/upcoming`);
  const out = {};
  for (const m of html.matchAll(/<a href="\/anime\/([^"?]+)" class="ac[^"]*">([\s\S]*?)<\/a>/g)) {
    const ts = parseItDate(firstMatch(/ac__sub">([^<·]+)/, m[2]) || '');
    if (ts) out[m[1]] = ts;
  }
  return out;
}

// --- stagioni -----------------------------------------------------------

// Il sito non etichetta le relazioni (prequel/sequel) nel listato: marchi e spin-off
// stanno nella stessa lista dei "Correlati". Quindi si raggruppa per titolo.
// "Reincarnated as a Sword 2" / "... (ITA)" => base "reincarnated as a sword", stagione 2, ita
export function parseTitle(raw) {
  let t = String(raw).trim();
  let lang = 'sub';
  if (/\(ita\)\s*$/i.test(t)) {
    lang = 'ita';
    t = t.replace(/\s*\(ita\)\s*$/i, '');
  }

  let season = 1;
  const m = /(?:season|stagione)\s*(\d{1,2})\s*$/i.exec(t);
  const ord = /(\d{1,2})(?:st|nd|rd|th)\s+season\s*$/i.exec(t);
  const tail = /^(.*\S)\s+(\d{1,2})$/.exec(t);
  if (m) {
    season = Number(m[1]);
    t = t.slice(0, m.index).trim();
  } else if (ord) {
    season = Number(ord[1]);
    t = t.slice(0, ord.index).trim();
  } else if (tail && Number(tail[2]) >= 2 && Number(tail[2]) <= 20) {
    // "Titolo 2" è una stagione, "Mob Psycho 100" no (numero fuori range, resta nel titolo)
    season = Number(tail[2]);
    t = tail[1].trim();
  }

  return { base: t.toLowerCase().replace(/\s+/g, ' '), season, lang, title: raw };
}

// Correlati di una serie (altri titoli della stessa famiglia)
export async function related(url) {
  const slug = slugOf(url);
  if (!slug) throw new Error('URL serie non riconosciuta');
  const html = await get(`${SITE}/related/${slug}`);
  const out = [];
  for (const m of html.matchAll(/<a href="\/anime\/([^"]+)" class="ac[^"]*">([\s\S]*?)<\/a>/g)) {
    const title = decodeEntities(firstMatch(/ac__title">([^<]+)</, m[2]) || '').trim();
    if (!title) continue;
    const sub = firstMatch(/ac__sub">([^<]*)/, m[2]) || '';
    out.push({
      slug: m[1],
      url: seriesUrl(m[1]),
      title,
      poster: firstMatch(/<img src="([^"]+)"/, m[2]) || '',
      episodes: Number(firstMatch(/(\d+)\s*ep/, sub)) || null,
      year: Number(firstMatch(/(\d{4})/, sub)) || null,
    });
  }
  return out;
}

// Serie + correlati raggruppati in stagioni della stessa lingua.
// [{ season, slug, title, url, poster, total, aired, status }] ordinate per stagione.
// Con un solo titolo la lista ha un elemento (niente scelta da fare).
export async function seasons(url) {
  const self = await series(url);
  const others = await related(url).catch(() => []);

  const selfInfo = parseTitle(self.title);
  const mine = { ...self, ...selfInfo };
  const family = [mine];

  for (const r of others) {
    const info = parseTitle(r.title);
    if (info.base !== selfInfo.base || info.lang !== selfInfo.lang) continue;
    if (r.slug === self.slug) continue;
    family.push({ ...r, ...info });
  }

  if (!family.length) return [];

  family.sort((a, b) => a.season - b.season);
  return family.map((f) => {
    const listed = Array.isArray(f.episodes) ? f.episodes.length : null;
    const total = f.totalEps ?? (typeof f.episodes === 'number' ? f.episodes : null) ?? listed;
    return {
      season: f.season,
      slug: f.slug,
      url: f.url,
      title: f.title,
      poster: f.poster || '',
      total,
      aired: listed ?? f.airedEps ?? total,
      status: f.status || '',
    };
  });
}

// --- profilo pubblico (nessun login) -----------------------------------

// "1234", "https://www.animesaturn.net/profile/1234", "/profile/1234/watchlist" -> "1234"
export function profileId(input) {
  const s = String(input ?? '').trim();
  const m = /(?:^|\/)profile\/(\d+)/.exec(s) || /^(\d+)$/.exec(s);
  return m ? String(Number(m[1])) : null;
}

// Pagina pubblica: i cookie si mandano solo se l'utente ha salvato un login,
// così un profilo privato resta un errore per chi non ha i permessi.
async function publicPage(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (r.status === 404) throw new Error('profilo non trovato (404)');
  if (r.status === 401 || r.status === 403) throw new Error('profilo non pubblico');
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${url}`);
  return r.text();
}

// tetto di sicurezza: se in futuro le liste vengono paginate non si tronca in silenzio
export const LIST_CAP = 200;

// Panoramica del profilo: nome, contatori watchlist, rail dei preferiti.
export function parseProfile(html) {
  const h = String(html);
  const name = decodeEntities(firstMatch(/user-profile__name">([^<]+)</, h) || '').trim();

  const counts = { watching: 0, planned: 0, completed: 0, paused: 0, dropped: 0 };
  const reCount = /wl-summary__dot wl-tone-(\w+)"><\/span>\s*<span class="wl-summary__label">[^<]*<\/span>\s*<strong class="wl-summary__count">(\d+)/g;
  for (const m of h.matchAll(reCount)) {
    if (m[1] in counts) counts[m[1]] = Number(m[2]);
  }

  // solo la sezione "Preferiti": la pagina ha altri rail (attività) con le stesse card
  const favAt = h.search(/id="profile-favorites"/);
  const favHtml = favAt < 0 ? '' : h.slice(favAt).split('</section>')[0];
  const favorites = [];
  for (const m of favHtml.matchAll(/<a href="\/anime\/([^"]+)" class="ac[^"]*">([\s\S]*?)<\/a>/g)) {
    const title = decodeEntities(firstMatch(/ac__title">([^<]+)</, m[2]) || '').trim();
    if (!title) continue;
    favorites.push({
      slug: m[1],
      title,
      url: seriesUrl(m[1]),
      poster: firstMatch(/<img src="([^"]+)"/, m[2]) || '',
    });
  }

  return { name, counts, favorites };
}

// Righe della watchlist: stato, progresso "Episodi 15/24", tipo/anno/stato del sito.
// La classe si matcha per prefisso: il sito aggiunge già modificatori altrove
// ("cal-day ", "cal-entry--pause"), quindi "wl-row" non è mai l'unica classe.
export function parseWatchlist(html) {
  const rows = [];
  for (const m of String(html).matchAll(/<li class="wl-row[^"]*">([\s\S]*?)<\/li>/g)) {
    const b = m[1];
    const slug = firstMatch(/href="\/anime\/([^"]+)"/, b);
    const title = decodeEntities(firstMatch(/wl-row__title">([^<]+)</, b) || '').trim();
    if (!slug || !title) continue;
    const meta = (firstMatch(/wl-row__meta">([^<]*)</, b) || '')
      .split(/\s*(?:&middot;|\u00b7)\s*/)
      .map((x) => decodeEntities(x).trim())
      .filter(Boolean);
    const progress = /Episodi\s*<strong>(\d+)\s*\/\s*(\d+)<\/strong>/.exec(b);
    rows.push({
      slug,
      title,
      url: seriesUrl(slug),
      poster: firstMatch(/<img src="([^"]+)"/, b) || '',
      type: meta[0] || '',
      year: Number(meta[1]) || null,
      siteStatus: meta[2] || '',
      badge: decodeEntities(firstMatch(/wl-badge wl-tone-\w+">[\s\S]*?<span>([^<]+)<\/span>/, b) || '').trim(),
      watched: progress ? Number(progress[1]) : 0,
      total: progress ? Number(progress[2]) : null,
    });
  }
  return { rows: rows.slice(0, LIST_CAP), truncated: rows.length > LIST_CAP };
}

// Panoramica + dettaglio watchlist in due GET pubbliche.
export async function profile(input) {
  const id = profileId(input);
  if (!id) throw new Error(`profilo non valido: ${input}`);
  const [overview, list] = await Promise.all([
    publicPage(`${SITE}/profile/${id}`),
    publicPage(`${SITE}/profile/${id}/watchlist`),
  ]);
  const meta = parseProfile(overview);
  const wl = parseWatchlist(list);
  // i contatori e le righe vengono da due pagine: se i contatori dicono che c'è roba
  // e le righe non si leggono, il markup è cambiato. Meglio un errore che un profilo "vuoto".
  const declared = Object.values(meta.counts).reduce((a, b) => a + b, 0);
  if (declared > 0 && !wl.rows.length) {
    throw new Error(`watchlist non letta: il profilo dichiara ${declared} serie (markup del sito cambiato?)`);
  }
  return { id, ...meta, watchlist: wl.rows, truncated: wl.truncated };
}

// --- calendario settimanale --------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// Il calendario non scrive l'anno: si ricava dalla settimana precedente linkata
// ("?week=2026-11-09" -> settimana corrente dal 16/11/2026).
export function calendarYear(html) {
  const m = /[?&]week=(\d{4})-(\d{2})-(\d{2})/.exec(String(html));
  if (!m) return new Date().getFullYear();
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 7));
  return d.getUTCFullYear();
}

// [{ slug, title, poster, ep, day, date:'YYYY-MM-DD', time:'HH:MM' }]
export function parseCalendar(html, year = calendarYear(html)) {
  const out = [];
  for (const day of String(html).matchAll(/<article class="cal-day[^"]*">([\s\S]*?)<\/article>/g)) {
    const b = day[1];
    const dayName = decodeEntities(firstMatch(/cal-day__name">([^<]+)</, b) || '').trim();
    const num = Number(firstMatch(/cal-day__num">(\d+)</, b));
    const month = MONTHS[(firstMatch(/cal-day__month">([^<]+)</, b) || '').trim().toLowerCase()];
    const date = num >= 1 && num <= 31 && month !== undefined ? `${year}-${pad2(month + 1)}-${pad2(num)}` : null;

    for (const e of b.matchAll(/<a href="\/anime\/([^"]+)" class="cal-entry[^"]*">([\s\S]*?)<\/a>/g)) {
      const body = e[2];
      const title = decodeEntities(firstMatch(/cal-entry__name">([^<]+)</, body) || '').trim();
      if (!title) continue;
      const ep = Number(firstMatch(/cal-entry__ep">Ep\.\s*(\d+)/, body));
      if (!ep) continue; // "In pausa": nessuna puntata da annunciare
      const timeHtml = firstMatch(/cal-entry__time">([\s\S]*?)<\/span>/, body) || '';
      const time = firstMatch(/(\d{1,2}:\d{2})/, timeHtml.replace(/<[^>]+>/g, ' ')) || '';
      out.push({
        slug: e[1],
        title,
        poster: firstMatch(/<img src="([^"]+)"/, body) || '',
        ep,
        day: dayName,
        date,
        time,
      });
    }
  }
  return out;
}

// Uscite della settimana in corso + la successiva (il link "?week=" della pagina la espone),
// così l'orario reale copre anche la prossima puntata delle serie che escono a inizio settimana.
export async function calendar() {
  const html = await publicPage(`${SITE}/calendar`);
  const out = parseCalendar(html);
  const declared = Number(firstMatch(/cal-filter__count">(\d+)</, html) || 0);
  if (declared > 0 && !out.length) {
    throw new Error(`calendario non letto: il sito dichiara ${declared} uscite (markup cambiato?)`);
  }

  const at = html.indexOf('aria-label="Settimana successiva"');
  const next = at < 0
    ? null
    : [...html.slice(Math.max(0, at - 300), at).matchAll(/\/calendar\?week=(\d{4}-\d{2}-\d{2})/g)].at(-1);
  if (next) {
    const more = await publicPage(`${SITE}/calendar?week=${next[1]}`).catch(() => '');
    for (const e of more ? parseCalendar(more) : []) {
      if (!out.some((x) => x.slug === e.slug && x.date === e.date && x.ep === e.ep)) out.push(e);
    }
  }
  return out;
}

// { date:'2026-11-16', time:'14:00' } -> epoch ms nel fuso locale
export function calendarTs(entry) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(entry?.date || ''));
  if (!d) return null;
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(entry?.time || ''));
  const ts = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t ? Number(t[1]) : 0, t ? Number(t[2]) : 0).getTime();
  return Number.isNaN(ts) ? null : ts;
}

// --- login facoltativo ----------------------------------------------------

// token antifrode del form /login
export function parseCsrf(html) {
  return firstMatch(/name="_csrf" value="([^"]+)"/, html) || '';
}

// POST del form /login: il sito risponde 303 (a /profile/<id> se le credenziali
// vanno bene, di nuovo a /login se no) e mette il cookie di sessione.
export async function login(user, pass) {
  const csrf = parseCsrf(await publicPage(`${SITE}/login`));
  if (!csrf) throw new Error('token CSRF non trovato (markup del sito cambiato?)');
  const r = await fetch(`${SITE}/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, login: user, password: pass, remember: '1' }).toString(),
  });
  const path = new URL(r.url || `${SITE}/login`).pathname;
  if (path.startsWith('/login')) throw new Error('credenziali rifiutate dal sito');
  return { ok: r.ok, path };
}

// --- feed globale episodi ----------------------------------------------

export async function episodesFeed() {
  const xml = await get(`${SITE}/rss/episodes`);
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const link = firstMatch(/<link>([^<]+)<\/link>/, block) || '';
    const pub = Date.parse(firstMatch(/<pubDate>([^<]+)<\/pubDate>/, block) || '');
    const ep = /\/episode\/([^/"]+)\/ep-(\d+)/.exec(link);
    if (!ep || Number.isNaN(pub)) continue;
    items.push({ slug: ep[1], n: Number(ep[2]), pubDate: pub, link });
  }
  return items;
}
