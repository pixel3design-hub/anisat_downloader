// Costruzione del feed RSS dei preferiti.
// Contiene TUTTE le puntate di TUTTE le stagioni aggiunte; se una stagione è in corso
// viene aggiunta la puntata successiva come voce "in arrivo" (senza link al video:
// è la riga "disabilitata" del feed).
// La data della prossima puntata non è pubblicata dal sito: è una stima basata sugli
// intervalli osservati (mediana), con fallback settimanale.

import { SITE, episodeUrl, seriesUrl } from '../sites/animesaturn.js';

const WEEK = 7 * 24 * 3600e3;

// Tutto ASCII: il feed viaggia come text/plain e può essere salvato con btoa().
function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]))
    .replace(/[^\x20-\x7e]/g, (c) => `&#${c.codePointAt(0)};`);
}

export function medianInterval(cadence = []) {
  const d = [];
  for (let i = 1; i < cadence.length; i++) {
    const diff = cadence[i] - cadence[i - 1];
    if (diff > 3600e3 && diff < 60 * 24 * 3600e3) d.push(diff);
  }
  if (!d.length) return WEEK;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

export function fmtRemaining(ms) {
  if (ms <= 0) return 'disponibile';
  const d = Math.floor(ms / 864e5);
  const h = Math.floor((ms % 864e5) / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  if (d > 0) return `${d}g ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function item({ title, link, guid, pubDate, description, image, category }) {
  return [
    '    <item>',
    `      <title>${esc(title)}</title>`,
    `      <link>${esc(link)}</link>`,
    `      <guid isPermaLink="false">${esc(guid)}</guid>`,
    `      <pubDate>${new Date(pubDate).toUTCString()}</pubDate>`,
    category ? `      <category>${esc(category)}</category>` : '',
    `      <description>${esc(description)}</description>`,
    image ? `      <media:thumbnail url="${esc(image)}"/>` : '',
    '    </item>',
  ].filter(Boolean).join('\n');
}

// catalog: [{ slug, title, poster, airedEps, totalEps, lastRelease, cadence:[ms], episodes:[{n}] }]
// upcoming: { slug: ms } per le serie non ancora iniziate
// calendar: { slug: [{ n, ts }] } orari reali del calendario del sito
// La prossima puntata usa l'orario del calendario quando c'è, altrimenti la stima.
export function buildFeed({ catalog = [], upcoming = {}, calendar = {}, now = Date.now() } = {}) {
  const items = [];

  for (const s of catalog) {
    const aired = s.airedEps || 0;
    if (!aired) continue;
    const interval = medianInterval(s.cadence);
    const last = s.lastRelease || (s.cadence && s.cadence.at(-1)) || null;
    if (!last) continue;

    const numbers = s.episodes?.length
      ? s.episodes.map((e) => (typeof e === 'number' ? e : e.n)).filter((n) => Number.isFinite(n))
      : Array.from({ length: aired }, (_, i) => i + 1);

    for (const n of numbers) {
      if (n > aired) continue;
      const ts = last - (aired - n) * interval;
      items.push({
        pubDate: ts,
        xml: item({
          title: `${s.title} — Ep ${n}`,
          link: episodeUrl(s.slug, n),
          guid: `${s.slug}#ep${n}`,
          pubDate: ts,
          description: `Episodio ${n} di ${s.title} — ${aired}/${s.totalEps} episodi usciti.`,
          image: s.poster,
        }),
      });
    }

    if (s.totalEps > aired) {
      const n = aired + 1;
      const fromCalendar = (calendar[s.slug] || []).find((c) => c.n === n && c.ts > now - 24 * 3600e3);
      const nextTs = fromCalendar?.ts || upcoming[s.slug] || last + interval;
      items.push({
        pubDate: nextTs,
        xml: item({
          title: `${s.title} — Ep ${n} (in arrivo)`,
          link: seriesUrl(s.slug), // niente link al video: puntata non ancora uscita
          guid: `${s.slug}#ep${n}`,
          pubDate: nextTs,
          category: 'in-arrivo',
          description:
            `Non ancora disponibile: ${fromCalendar ? 'in uscita da calendario' : 'previsto'} ${fmtDate(nextTs)} (${fmtRemaining(nextTs - now)}). ` +
            (fromCalendar
              ? 'Orario pubblicato nel calendario del sito. '
              : `Stima basata su ${s.cadence?.length > 1 ? `intervallo osservato di ${Math.round(interval / 864e5)}g` : 'cadenza settimanale'}. `) +
            `${aired}/${s.totalEps} usciti.`,
          image: s.poster,
        }),
      });
    }
  }

  items.sort((a, b) => b.pubDate - a.pubDate);

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>AniSat Downloader - preferiti</title>
    <link>${esc(SITE)}</link>
    <atom:link href="http://127.0.0.1:8787/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Uscite e prossimi episodi delle serie preferite su animesaturn.net</description>
    <language>it-IT</language>
    <lastBuildDate>${new Date(now).toUTCString()}</lastBuildDate>
    <ttl>30</ttl>
${items.map((i) => i.xml).join('\n')}
  </channel>
</rss>
`;
}
