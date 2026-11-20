// Verifica dell'unica logica non banale: parsing delle pagine reali del sito
// (fixture registrate il 2026-11-19), decodifica del manifest del player,
// raggruppamento delle stagioni e costruzione del feed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as site from '../sites/animesaturn.js';
import { buildFeed, medianInterval } from '../lib/feed.js';
import { buildView, missingSeasons, statusKey, statusSections } from '../lib/group.js';
import { aria2List, ytdlpList } from '../lib/listfile.js';

const read = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

const SERIES_HTML = read('series.html');
const EPISODE_HTML = read('episode.html');
const RELATED_HTML = read('related.html');
const PLAYLIST = read('playlist.json');
const PROFILE_HTML = read('profile.html');
const WATCHLIST_HTML = read('watchlist.html');
const CALENDAR_HTML = read('calendar.html');
const LOGIN_HTML = read('login.html');
const SERIES_URL = 'https://www.animesaturn.net/anime/reincarnated-as-a-sword-season-2-j9hRW';

const realFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/playlist?')) return new Response(PLAYLIST, { status: 200 });
    if (u.includes('/related/')) return new Response(RELATED_HTML, { status: 200 });
    // solo il profilo 286 esiste: qualunque altro id risponde 404 come il sito
    const prof = /\/profile\/(\d+)(\/watchlist)?$/.exec(u);
    if (prof) {
      if (prof[1] !== '286') return new Response('<html>non trovato</html>', { status: 404 });
      return new Response(prof[2] ? WATCHLIST_HTML : PROFILE_HTML, { status: 200 });
    }
    if (u.includes('/calendar')) return new Response(CALENDAR_HTML, { status: 200 });
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

test('profilo: id accettato come numero, URL o input sporco', () => {
  assert.equal(site.profileId('286'), '286');
  assert.equal(site.profileId(' https://www.animesaturn.net/profile/286 '), '286');
  assert.equal(site.profileId('/profile/286/watchlist'), '286');
  assert.equal(site.profileId('0286'), '286');
  assert.equal(site.profileId(''), null);
  assert.equal(site.profileId('non-un-profilo'), null);
  assert.equal(site.profileId(null), null);
});

test('profilo: nome, contatori, preferiti e watchlist', async () => {
  const p = await site.profile('https://www.animesaturn.net/profile/286');
  assert.equal(p.id, '286');
  assert.equal(p.name, 'bazinga');
  assert.deepEqual(p.counts, { watching: 2, planned: 2, completed: 0, paused: 0, dropped: 0 });
  assert.deepEqual(p.favorites.map((f) => f.slug), [
    'da-wang-rao-ming-VnjTf',
    'reincarnated-as-a-sword-season-2-j9hRW',
    'the-apothecary-diaries-2-ita-YxWKM',
  ]);
  assert.equal(p.truncated, false);
  assert.equal(p.watchlist.length, 4);
  assert.deepEqual(p.watchlist[3], {
    slug: 'the-apothecary-diaries-2-ita-YxWKM',
    title: 'The Apothecary Diaries 2 (ITA)',
    url: 'https://www.animesaturn.net/anime/the-apothecary-diaries-2-ita-YxWKM',
    poster: 'https://img.saturncdn.net/static/images/locandine/VgMgs.jpg',
    type: 'TV',
    year: 2025,
    siteStatus: 'Finito',
    badge: 'In corso',
    watched: 15,
    total: 24,
  });
});

test('profilo: id inesistente -> errore esplicito, non una lista vuota', async () => {
  await assert.rejects(() => site.profile('999'), /profilo non trovato \(404\)/);
});

test('watchlist: oltre il tetto si tronca e lo dice', () => {
  const li = (i) => `<li class="wl-row"><a href="/anime/s${i}" class="wl-row__poster"><img src=""></a>` +
    `<div class="wl-row__head"><a href="/anime/s${i}" class="wl-row__title">S${i}</a>` +
    `<p class="wl-row__meta">TV &middot; 2021 &middot; In corso</p></div>` +
    `<span class="wl-badge wl-tone-watching"><span>In corso</span></span>` +
    `<span class="wl-fact">Episodi <strong>1/12</strong></span></li>`;
  const html = `<ul>${Array.from({ length: site.LIST_CAP + 1 }, (_, i) => li(i)).join('')}</ul>`;
  const w = site.parseWatchlist(html);
  assert.equal(w.rows.length, site.LIST_CAP);
  assert.equal(w.truncated, true);
  assert.equal(w.rows[0].year, 2021);
});

test('sezioni: ogni serie finisce nello stato della sua watchlist', () => {
  assert.equal(statusKey('In corso'), 'watching');
  assert.equal(statusKey('Da guardare'), 'planned');
  assert.equal(statusKey('Completati'), 'completed');
  assert.equal(statusKey('Droppati'), 'dropped');
  assert.equal(statusKey('boh'), 'none');
  assert.equal(statusKey(''), 'none');

  const sections = statusSections([
    { slug: 'b1', title: 'Tokyo Revengers', listStatus: 'Da guardare' },
    { slug: 'c1', title: 'Serie Finita', listStatus: 'Completato' },
    { slug: 'd1', title: 'Serie Mollata', listStatus: 'Droppato' },
    { slug: 'a1', title: 'Mob Psycho 100', listStatus: 'In corso' },
    { slug: 'a2', title: 'Mob Psycho 100 2', listStatus: 'In corso' },
    { slug: 'e1', title: 'Aggiunta a mano' },
  ]);

  assert.deepEqual(sections.map((s) => [s.key, s.count]), [
    ['watching', 2],
    ['planned', 1],
    ['completed', 1],
    ['dropped', 1],
    ['none', 1],
  ]);
  assert.deepEqual(sections[0].series.map((s) => s.slug), ['a1', 'a2']);
});

test('famiglie: le stagioni vanno in tendina e non si duplicano nelle sezioni', () => {
  const list = [
    { slug: 'tougen', title: 'Tougen Anki', listStatus: 'Completato' },
    { slug: 'tougen-arc', title: 'Tougen Anki: Nikko Kegon Falls Arc', listStatus: 'In corso' },
    { slug: 'tokyo', title: 'Tokyo Revengers', listStatus: 'In corso' },
  ];
  // la famiglia viene dai correlati del sito: i titoli non c'entrano
  const families = [{ key: 'tougen|tougen-arc', title: 'Tougen Anki', slugs: ['tougen', 'tougen-arc'] }];

  const view = buildView(list, families);
  assert.equal(view.multi.length, 1);
  assert.deepEqual(view.multi[0].series.map((s) => s.slug), ['tougen', 'tougen-arc']);
  // l'unica serie fuori famiglia resta nella sua sezione
  assert.deepEqual(view.sections.map((s) => [s.key, s.series.map((x) => x.slug)]), [['watching', ['tokyo']]]);

  // famiglia con una sola stagione in lista: niente tendina, torna nella sezione
  const solo = buildView(list, [{ key: 'k', title: 'Tougen Anki', slugs: ['tougen'] }]);
  assert.equal(solo.multi.length, 0);
  assert.deepEqual(solo.sections.flatMap((s) => s.series.map((x) => x.slug)).sort(), ['tokyo', 'tougen', 'tougen-arc'].sort());
});

test('stagioni mancanti: solo quelle non già nei preferiti', () => {
  const family = [{ slug: 's1' }, { slug: 's2' }, { slug: 's3' }];
  assert.deepEqual(missingSeasons(family, ['s1', 's3']).map((s) => s.slug), ['s2']);
  assert.deepEqual(missingSeasons(family, ['s1', 's2', 's3']), []);
  assert.deepEqual(missingSeasons([], ['s1']), []);
});

test('login: token CSRF dal form e credenziali rifiutate', async () => {
  assert.equal(site.parseCsrf(LOGIN_HTML), 'csrf-di-prova');
  assert.equal(site.parseCsrf('<html></html>'), '');

  const stub = globalThis.fetch;
  let posted = null;
  const answer = (finalUrl) => async (url, opts = {}) => {
    if (!opts.method) return new Response(LOGIN_HTML, { status: 200 });
    posted = new URLSearchParams(opts.body);
    const r = new Response('', { status: 200 });
    Object.defineProperty(r, 'url', { value: finalUrl });
    return r;
  };
  try {
    globalThis.fetch = answer('https://www.animesaturn.net/login');
    await assert.rejects(() => site.login('utente', 'sbagliata'), /credenziali rifiutate/);
    assert.equal(posted.get('_csrf'), 'csrf-di-prova');
    assert.equal(posted.get('login'), 'utente');
    assert.equal(posted.get('remember'), '1');

    globalThis.fetch = answer('https://www.animesaturn.net/profile/286');
    assert.deepEqual(await site.login('utente', 'giusta'), { ok: true, path: '/profile/286' });
  } finally {
    globalThis.fetch = stub;
  }
});

test('liste: la risoluzione reale dell\'episodio finisce nel file', async () => {
  // fixture vere: pagina episodio + manifest del player -> URL diretto -> lista
  const r = await site.resolveStream(site.episodeUrl('reincarnated-as-a-sword-season-2-j9hRW', 1));
  const entry = { n: 1, url: r.url, hls: r.hls, out: 'AnimeSaturn/Serie/Serie - Ep 01.mp4' };

  const aria = aria2List({ title: 'Serie', episodes: [entry] });
  assert.match(aria, /srv\d+\.\w+\.streampeaker\.org\/DDL\/ANIME\/.*Ep_01_SUB_ITA\.mp4\?token=/);
  assert.match(aria, / {2}out=AnimeSaturn\/Serie\/Serie - Ep 01\.mp4/);

  const ytdl = ytdlpList({ title: 'Serie', episodes: [entry] });
  assert.equal((ytdl.match(/^https:/gm) || []).length, 1);
});

test('liste per aria2 e yt-dlp: URL, out= e fonti HLS', () => {
  const episodes = [
    { n: 1, url: 'https://srv1.x/Ep_01.mp4?token=a', out: 'AnimeSaturn/X/X - Ep 01.mp4' },
    { n: 2, url: null, hls: 'https://srv1.x/Ep_02.m3u8?token=b' },
    { n: 3, url: null, hls: null, error: 'HTTP 403' },
  ];

  const aria = aria2List({ title: 'X', file: 'X-aria2.txt', episodes });
  assert.match(aria, /aria2c -c -i X-aria2\.txt/);
  assert.match(aria, /Ep_01\.mp4\?token=a\n {2}out=AnimeSaturn\/X\/X - Ep 01\.mp4/);
  // aria2 non scarica HLS: la riga 2 non deve contenere un URL
  assert.match(aria, /# ep 2: solo HLS \(aria2 non lo scarica\), usa la lista yt-dlp/);
  assert.match(aria, /# ep 3: nessuna fonte utilizzabile \(HTTP 403\)/);
  assert.equal((aria.match(/^https:/gm) || []).length, 1);

  const ytdl = ytdlpList({ title: 'X', file: 'X-ytdlp.txt', episodes });
  assert.match(ytdl, /yt-dlp --batch-file X-ytdlp\.txt/);
  assert.match(ytdl, /# ep 2\nhttps:\/\/srv1\.x\/Ep_02\.m3u8\?token=b/);
  assert.match(ytdl, /# ep 3: nessuna fonte utilizzabile/);
  assert.equal((ytdl.match(/^https:/gm) || []).length, 2);
  // il file yt-dlp resta caricabile: solo ASCII
  assert.ok([aria, ytdl].every((t) => t.split('\n').every((l) => !/[^\x00-\x7f]/.test(l))));
});

test('markup: i modificatori di classe non azzerano watchlist e preferiti', () => {
  // il sito usa già varianti ("cal-day ", "cal-entry--pause"): il prefisso deve bastare
  const wl = site.parseWatchlist(WATCHLIST_HTML.replaceAll('<li class="wl-row">', '<li class="wl-row wl-row--compact">'));
  assert.equal(wl.rows.length, 4);
  assert.equal(wl.rows[0].slug, 'tokyo-revengers-KMweA');
  assert.equal(wl.rows[3].watched, 15);

  const p = site.parseProfile(PROFILE_HTML.replaceAll('class="ac group"', 'class="ac group ac--wide"'));
  assert.equal(p.favorites.length, 3);
});

test('profilo: contatori > 0 ma zero righe -> errore, non un profilo vuoto', async () => {
  const stub = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith('/watchlist')
      ? new Response('<html><body><ul class="card"><li>niente</li></ul></body></html>', { status: 200 })
      : new Response(PROFILE_HTML, { status: 200 });
  try {
    await assert.rejects(() => site.profile('286'), /watchlist non letta: il profilo dichiara 4 serie/);
  } finally {
    globalThis.fetch = stub;
  }
});

test('calendario: giorno, ora, Ep. N e anno dalla settimana linkata', async () => {
  const list = await site.calendar();
  // la fixture risponde anche alla settimana successiva: le voci uguali non si duplicano
  assert.equal(list.length, 12, 'la voce "In pausa" senza puntata è esclusa');
  assert.deepEqual(list[0], {
    slug: 'hello-i-am-a-witch-and-my-crush-wants-me-to-make-a-love-potion-qe2B5',
    title: 'Hello, I Am a Witch and My Crush Wants Me to Make a Love Potion!',
    poster: 'https://img.saturncdn.net/static/images/locandine/6c31890f81cf630b.png',
    ep: 7,
    day: 'Lunedì',
    date: '2026-11-16',
    time: '14:00',
  });
  // entità HTML decodificate nei titoli
  assert.ok(list.some((e) => e.title === "So What's Wrong with Getting Reborn as a Goblin?"));
  assert.equal(new Date(site.calendarTs(list[0])).getTime(), new Date(2026, 10, 16, 14, 0).getTime());
});

test('calendario: settimana vuota per markup cambiato -> errore, non zero uscite', async () => {
  const stub = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('<div class="cal-hero__filters"><span class="cal-filter__count">82</span></div>', { status: 200 });
  try {
    await assert.rejects(() => site.calendar(), /calendario non letto: il sito dichiara 82 uscite/);
  } finally {
    globalThis.fetch = stub;
  }
});

test('feed: la puntata in arrivo usa l\'orario del calendario', () => {
  const now = Date.parse('2026-11-16T20:00:00Z');
  const last = now;
  const calTs = new Date(2026, 10, 23, 14, 0).getTime();
  const xml = buildFeed({
    now,
    calendar: { s: [{ n: 9, ts: calTs }] },
    catalog: [
      {
        slug: 's',
        title: 'Serie',
        airedEps: 8,
        totalEps: 12,
        lastRelease: last,
        cadence: [last - 7 * 864e5, last],
        episodes: Array.from({ length: 8 }, (_, i) => ({ n: i + 1 })),
      },
    ],
  });
  assert.match(xml, /in uscita da calendario/);
  assert.match(xml, /Orario pubblicato nel calendario/);
  const item = xml.split('<item>').find((b) => b.includes('Ep 9 (in arrivo)'));
  assert.ok(item);
  assert.match(item, new RegExp(`<pubDate>${new Date(calTs).toUTCString().replace(/[+]/g, '\\+')}</pubDate>`));
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
