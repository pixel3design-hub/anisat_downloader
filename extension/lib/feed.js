// Costruzione del feed RSS dei preferiti: date di uscita + stima della prossima puntata.
// Il sito non pubblica la data della puntata successiva, quindi la stima deriva dagli
// intervalli osservati tra le uscite (mediana) oppure dal fallback settimanale.

import { SITE, episodeUrl, seriesUrl } from '../sites/animesaturn.js';

const WEEK = 7 * 24 * 3600e3;

// Tutto ASCII: il feed viene poi passato a btoa() per il data URL.
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

function item({ title, link, guid, pubDate, description, image }) {
  return [
    '    <item>',
    `      <title>${esc(title)}</title>`,
    `      <link>${esc(link)}</link>`,
    `      <guid isPermaLink="false">${esc(guid)}</guid>`,
    `      <pubDate>${new Date(pubDate).toUTCString()}</pubDate>`,
    `      <description>${esc(description)}</description>`,
    image ? `      <media:thumbnail url="${esc(image)}"/>` : '',
    '    </item>',
  ].filter(Boolean).join('\n');
}

// catalog: [{ slug, title, poster, airedEps, totalEps, lastRelease, cadence:[ms] }]
// upcoming: { slug: ms } per le serie non ancora iniziate
export function buildFeed({ catalog = [], upcoming = {}, now = Date.now() } = {}) {
  const items = [];

  for (const s of catalog) {
    if (!s.airedEps) continue;
    const interval = medianInterval(s.cadence);
    const last = s.lastRelease || (s.cadence && s.cadence.at(-1)) || null;
    if (!last) continue;

    const aired = Math.min(s.airedEps, s.episodes?.length || s.airedEps);
    for (let n = Math.max(1, aired - 2); n <= aired; n++) {
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
      const nextTs = upcoming[s.slug] || last + interval;
      items.push({
        pubDate: nextTs,
        xml: item({
          title: `${s.title} — Ep ${aired + 1} (stimato)`,
          link: seriesUrl(s.slug),
          guid: `${s.slug}#ep${aired + 1}`,
          pubDate: nextTs,
          description:
            `Prossimo episodio: ${fmtDate(nextTs)} (${fmtRemaining(nextTs - now)}). ` +
            `Stima basata su ${s.cadence?.length > 1 ? `intervallo osservato di ${Math.round(interval / 864e5)}g` : 'cadenza settimanale'}. ` +
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
