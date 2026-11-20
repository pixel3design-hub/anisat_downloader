// Verifica dell'unica logica non banale: parsing delle pagine reali del sito
// (fixture registrate il 2026-11-19), decodifica del manifest del player,
// raggruppamento delle stagioni e costruzione del feed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as site from '../sites/animesaturn.js';
import { buildFeed, medianInterval } from '../lib/feed.js';
import { splitPath } from '../lib/folder.js';

const read = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const SERIES_HTML = read('series.html');
const EPISODE_HTML = read('episode.html');
const RELATED_HTML = read('related.html');
const PLAYLIST = read('playlist.json');
const SERIES_URL = 'https://www.animesaturn.net/anime/reincarnated-as-a-sword-season-2-j9hRW';

const realFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/playlist?')) return new Response(PLAYLIST, { status: 200 });
    if (u.includes('/related/')) return new Response(RELATED_HTML, { status: 200 });
    if (/\/ep-\d+$/.test(new URL(u).pathname)) return new Response(EPISODE_HTML, { status: 200 });
    if (u.includes('/anime/')) return new Response(SERIES_HTML, { status: 200 });
    throw new Error(`URL non previsto nel test: ${u}`);
  };
});

test.after(() => {
  globalThis.fetch = realFetch;
});

test('pagina serie: previsti 12, usciti 8, 8 episodi elencati', async () => {
  const s = await site.series(SERIES_URL);
  assert.equal(s.slug, 'reincarnated-as-a-sword-season-2-j9hRW');
  assert.equal(s.title, 'Reincarnated as a Sword 2');
  assert.equal(s.totalEps, 12);
  assert.equal(s.airedEps, 8);
  assert.equal(s.status, 'In corso');
  assert.equal(s.episodes.length, 8);
  assert.deepEqual(s.episodes[0], { n: 1, url: 'https://www.animesaturn.net/anime/reincarnated-as-a-sword-season-2-j9hRW/ep-1' });
  assert.equal(s.episodes[7].n, 8);
});

test('episodio: URL mp4 diretto dopo la decodifica XOR del manifest', async () => {
  const r = await site.resolveStream(site.episodeUrl('reincarnated-as-a-sword-season-2-j9hRW', 1));
  assert.match(r.url, /^https:\/\/srv\d+\.\w+\.streampeaker\.org\/DDL\/ANIME\//);
  assert.match(r.url, /Ep_01_SUB_ITA\.mp4\?token=/);
  assert.equal(r.hls, null);
  // il fixture contiene expires=1795139252: verifica deterministica, non legata all'orologio
  assert.equal(r.expiresAt, 1795139252 * 1000);
});

test('titoli: stagione e lingua', () => {
  assert.deepEqual(
    (({ base, season, lang }) => ({ base, season, lang }))(site.parseTitle('Reincarnated as a Sword 2')),
    { base: 'reincarnated as a sword', season: 2, lang: 'sub' },
  );
  assert.deepEqual(
    (({ base, season, lang }) => ({ base, season, lang }))(site.parseTitle('Reincarnated as a Sword (ITA)')),
    { base: 'reincarnated as a sword', season: 1, lang: 'ita' },
  );
  assert.equal(site.parseTitle('X 2nd Season').season, 2);
  assert.equal(site.parseTitle('Y Season 3').season, 3);
  // numero alto: non è una stagione, resta nel titolo
  assert.equal(site.parseTitle('Mob Psycho 100').season, 1);
  assert.equal(site.parseTitle('Mob Psycho 100').base, 'mob psycho 100');
});

test('stagioni: correlati raggruppati per titolo e lingua', async () => {
  const list = await site.seasons(SERIES_URL);
  assert.equal(list.length, 2, 'ita e film esclusi');
  assert.deepEqual(list.map((x) => x.season), [1, 2]);
  assert.equal(list[0].slug, 'tensei-shitara-ken-deshita-4NA2f');
  assert.equal(list[1].slug, 'reincarnated-as-a-sword-season-2-j9hRW');
  assert.equal(list[1].aired, 8);
  assert.equal(list[1].total, 12);
});

test('intervallo: mediana di una cadenza settimanale', () => {
  const week = 7 * 24 * 3600e3;
  const t = Date.parse('2026-10-12T20:00:00Z');
  assert.equal(medianInterval([t, t + week, t + 2 * week]), week);
  assert.equal(medianInterval([]), week);
});

test('feed: tutte le puntate + riga "in arrivo" disabilitata, tutto ASCII', () => {
  const week = 7 * 24 * 3600e3;
  const last = Date.parse('2026-11-16T20:00:00Z');
  const xml = buildFeed({
    now: last,
    catalog: [
      {
        slug: 'reincarnated-as-a-sword-season-2-j9hRW',
        title: 'Reincarnated as a Sword 2',
        poster: 'https://img.saturncdn.net/x.png',
        airedEps: 8,
        totalEps: 12,
        lastRelease: last,
        cadence: [last - 2 * week, last - week, last],
        episodes: Array.from({ length: 8 }, (_, i) => ({ n: i + 1 })),
      },
    ],
  });

  // 8 puntate uscite + 1 in arrivo
  assert.equal((xml.match(/<item>/g) || []).length, 9);
  assert.match(xml, /Ep 9 \(in arrivo\)/);
  assert.match(xml, /<category>in-arrivo<\/category>/);
  assert.match(xml, /Episodio 1 di Reincarnated as a Sword 2/);
  assert.match(xml, /8\/12 episodi usciti/);
  assert.ok(xml.split('\n').every((l) => !/[^\x00-\x7f]/.test(l)), 'feed non ASCII');
  assert.doesNotThrow(() => btoa(xml));
  // la puntata stimata (futura) sta in cima
  const titles = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1]);
  assert.equal(titles[1], 'Reincarnated as a Sword 2 &#8212; Ep 9 (in arrivo)');
});

test('percorso cartella: sottocartelle e nome file', () => {
  assert.deepEqual(splitPath('AnimeSaturn/Serie X/Serie X - Ep 01.mp4'), {
    dirs: ['AnimeSaturn', 'Serie X'],
    name: 'Serie X - Ep 01.mp4',
  });
  assert.deepEqual(splitPath('solo-file.mp4'), { dirs: [], name: 'solo-file.mp4' });
  assert.deepEqual(splitPath('///'), { dirs: [], name: 'download.mp4' });
});
