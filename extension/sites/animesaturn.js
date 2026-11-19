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
  for (const m of html.matchAll(/<a href="\/anime\/([^"?]+)" class="ac group">([\s\S]*?)<\/a>/g)) {
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
  for (const m of html.matchAll(/<a href="\/anime\/([^"]+)" class="ac group">([\s\S]*?)<\/a>/g)) {
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
