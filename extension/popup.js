import { api as webext } from './lib/api.js';
import { buildView } from './lib/group.js';
import { calendarTs } from './sites/animesaturn.js';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

let st = { series: {}, episodes: {}, seen: {}, queue: [], news: {}, settings: {}, feedState: {}, account: null, families: null, hasLogin: false };

if (new URLSearchParams(location.search).has('tab')) document.body.classList.add('tab');

async function api(type, extra = {}) {
  const r = await webext.runtime.sendMessage({ type, ...extra });
  if (!r) throw new Error('nessuna risposta dal service worker');
  if (!r.ok) {
    const err = new Error(r.error);
    err.serverDown = r.serverDown;
    throw err;
  }
  return r.data;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3200);
}

// --- tab ----------------------------------------------------------------

for (const b of document.querySelectorAll('nav button')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== b.dataset.tab;
  });
}

// --- modale -------------------------------------------------------------

function closeModal() {
  $('#modal').hidden = true;
  $('#modalBody').replaceChildren();
  $('#modalActions').replaceChildren();
}

function openModal(title, bodyHtml, actions) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  const box = $('#modalActions');
  box.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.secondary) b.className = 'secondary';
    b.addEventListener('click', () => a.onClick?.());
    box.appendChild(b);
  }
  $('#modal').hidden = false;
}

// Chiede cosa fare quando il servizio anisat-feed non risponde.
function askServer(error) {
  openModal(
    'Server RSS non raggiungibile',
    `<p>${esc(error || 'nessuna risposta su http://127.0.0.1:8787')}</p>
     <p class="hint">Il feed non è stato salvato. Puoi avviare il servizio e riprovare, oppure salvare
     il file <code>feed.rss</code> e usarlo con un lettore RSS locale.</p>
     <p class="hint">Comando: <code>anisat-feed</code></p>`,
    [
      {
        label: 'Avvia il server',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText('anisat-feed');
            toast('Comando copiato: avvialo, poi premi Riprova');
          } catch {
            toast('Avvia "anisat-feed" in un terminale, poi premi Riprova');
          }
          askServer(error);
        },
      },
      {
        label: 'Riprova',
        secondary: true,
        onClick: async () => {
          try {
            await api('pushFeed', { force: true });
            closeModal();
            toast('Feed inviato al server');
            await load();
          } catch (e) {
            askServer(e.message);
          }
        },
      },
      {
        label: 'Salva feed.rss',
        secondary: true,
        onClick: async () => {
          try {
            await api('saveFeed');
            closeModal();
            toast('feed.rss salvato nella cartella Download');
          } catch (e) {
            toast(`Errore: ${e.message}`);
          }
        },
      },
      { label: 'Annulla', secondary: true, onClick: closeModal },
    ],
  );
}

// --- rendering ----------------------------------------------------------

const open = new Set();

// i preferiti sono quelli marcati sul sito: il cuore è un indicatore, non un interruttore
const siteFavorites = () => new Set((st.account?.favorites || []).map((f) => f.slug));

function seriesCard(s) {
  const news = st.news[s.slug] || 0;
  const heart = siteFavorites().has(s.slug)
    ? '<span class="heart on" title="Fra i preferiti del tuo profilo AnimeSaturn">♥</span>'
    : '';
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.slug = s.slug;
  el.innerHTML = `
    <img src="${esc(s.poster)}" alt="" loading="lazy">
    <div>
      <h3>${esc(s.title)}${news ? `<span class="badge">${news}</span>` : ''}</h3>
      <p>${s.airedEps}/${s.totalEps} episodi · ${esc(s.status || '')}${s.listStatus && s.listStatus !== s.status ? ` · ${esc(s.listStatus)}` : ''}</p>
    </div>
    ${heart}
    <div class="actions">
      <button data-act="toggle" data-slug="${esc(s.slug)}">Episodi</button>
      <button data-act="new" data-slug="${esc(s.slug)}">Scarica nuovi</button>
      <button data-act="list" data-slug="${esc(s.slug)}">Lista file</button>
      <button data-act="remove" data-slug="${esc(s.slug)}">✕</button>
    </div>
    <div class="eps" data-eps="${esc(s.slug)}" hidden></div>`;
  return el;
}

function groupHeading(text) {
  const head = document.createElement('h2');
  head.className = 'group';
  head.textContent = text;
  return head;
}

// Famiglie con più stagioni: una tendina per famiglia, stagioni dentro.
function familyBlock(fam) {
  const details = document.createElement('details');
  details.className = 'fam';
  details.dataset.family = fam.key;
  const summary = document.createElement('summary');
  const seasons = [...new Set(fam.series.map((s) => s.season || 1))].sort((a, b) => a - b);
  summary.innerHTML = `<span>${esc(fam.title)}</span>
    <small>${fam.series.length} stagioni${seasons.length > 1 ? ` · S${seasons[0]}–S${seasons.at(-1)}` : ''}</small>`;
  details.appendChild(summary);
  for (const s of fam.series) details.appendChild(seriesCard(s));
  return details;
}

function renderSeries() {
  const list = Object.values(st.series);
  const box = $('#seriesList');
  const view = buildView(list, st.families?.groups || []);

  const nodes = [];
  if (view.multi.length) {
    nodes.push(groupHeading(`Serie con più stagioni (${view.multi.length})`));
    nodes.push(...view.multi.map(familyBlock));
  }
  for (const section of view.sections) {
    nodes.push(groupHeading(`${section.label} (${section.count})`));
    nodes.push(...section.series.map(seriesCard));
  }
  box.replaceChildren(...nodes);
  $('#emptyHint').hidden = list.length > 0;
  for (const slug of open) fillEps(slug);

  const fEl = $('#folderState');
  fEl.textContent = st.serviceOk
    ? 'Download: gestiti dal servizio, nella cartella impostata nella sua pagina'
    : 'Download: cartella predefinita del browser (avvia anisat-feed per non ricevere il dialogo a ogni file)';

  const f = st.feedState || {};
  const el = $('#feedState');
  if (!f.at) el.textContent = 'Feed: mai inviato al server';
  else el.textContent = `${f.ok ? 'Feed inviato' : 'Feed NON inviato'} · ${new Date(f.at).toLocaleString('it-IT')}${f.bytes ? ` · ${(f.bytes / 1024).toFixed(1)} KB` : ''}${f.path ? ` · ${f.path}` : ''}`;
}

function fillEps(slug) {
  const box = document.querySelector(`[data-eps="${CSS.escape(slug)}"]`);
  if (!box) return;
  const series = st.series[slug];
  const eps = [...(st.episodes[slug] || [])].sort((a, b) => b.n - a.n);
  const seen = new Set(st.seen[slug] || []);
  const aired = series?.airedEps || 0;

  box.hidden = !open.has(slug);
  if (box.hidden) return;

  const rows = eps.map((e) => {
    const pending = e.n > aired; // puntata non ancora uscita: riga disabilitata
    return `
      <div class="ep ${seen.has(e.n) ? 'seen' : ''} ${pending ? 'pending' : ''}">
        <label><input type="checkbox" data-pick="${e.n}" value="${e.n}" ${pending ? 'disabled' : ''}>
          <span class="n">Ep ${e.n}</span>${pending ? ' <small>(in arrivo)</small>' : ''}</label>
        <button data-act="seen" data-slug="${esc(slug)}" data-n="${e.n}" data-value="${seen.has(e.n) ? 0 : 1}" ${pending ? 'disabled' : ''}>${seen.has(e.n) ? '↺' : '✓'}</button>
        <button data-act="dlEp" data-slug="${esc(slug)}" data-n="${e.n}" ${pending || seen.has(e.n) ? '' : ''} ${pending ? 'disabled' : ''}>↓</button>
      </div>`;
  });

  box.innerHTML = `
    <div class="row">
      <button data-act="dlSelected" data-slug="${esc(slug)}">Scarica selezionati</button>
      <button data-act="selectAll" data-slug="${esc(slug)}">Seleziona tutti</button>
    </div>
    ${rows.join('') || '<p class="hint">Nessun episodio trovato.</p>'}`;
}

function renderQueue() {
  const items = st.queue.map((q, i) => {
    const title = st.series[q.slug]?.title || q.slug;
    const pct = q.state === 'downloading' && q.progress != null ? ` ${q.progress}%` : '';
    const state = q.state === 'done' ? '✓' : q.state === 'downloading' ? `…${pct}` : q.state === 'error' ? '⚠' : '·';
    const retry = q.state === 'error'
      ? `<button data-act="retry" data-id="${q.downloadId ?? i}" data-slug="${esc(q.slug)}" data-n="${q.n}">Riprova</button>`
      : '';
    const err = q.error ? `<small>${esc(q.error)}</small>` : '';
    return `<div class="q">
      <div><span class="n">${state}</span> ${esc(title)} — Ep ${q.n} ${err}</div>
      <div>${retry}<button data-act="cancel" data-id="${q.downloadId ?? i}">✕</button></div>
    </div>`;
  });
  $('#queueList').innerHTML = items.join('') || '<p class="hint">Coda vuota.</p>';
}

function render() {
  renderSeries();
  renderQueue();
  renderAccount();
  renderOutings();
}

async function load() {
  st = await api('state');
  render();
  // le famiglie (correlati del sito) mancano dopo un'aggiunta o una rimozione:
  // una volta per apertura, poi si ridisegna
  if (Object.keys(st.series).length && !st.families && !load.familiesAsked) {
    load.familiesAsked = true;
    try {
      await api('families');
      st = await api('state');
      render();
    } catch {
      // senza correlati restano le sezioni per stato
    }
  }
}

// --- aggiunta serie (scelta stagioni) -----------------------------------

async function addFlow(url) {
  toast('Cerco le stagioni…');
  let seasons;
  try {
    seasons = await api('seasons', { url });
  } catch (e) {
    // niente correlati o pagina non valida: provo l'aggiunta diretta
    seasons = null;
  }

  if (!seasons || !seasons.length) {
    toast('Nessuna stagione trovata');
    return;
  }

  if (seasons.length === 1) {
    await commitAdd([seasons[0].slug]);
    return;
  }

  const rows = seasons
    .map(
      (s) => `<label class="season">
        <input type="checkbox" value="${esc(s.slug)}" checked>
        <span><strong>Stagione ${s.season}</strong> — ${esc(s.title)}<br>
        <small>${s.aired ?? '?'}${s.total && s.total !== s.aired ? `/${s.total}` : ''} episodi · ${esc(s.status || '')}</small></span>
      </label>`,
    )
    .join('');

  openModal(
    'Quali stagioni aggiungere?',
    `<div id="seasonList">${rows}</div>`,
    [
      {
        label: 'Aggiungi selezionate',
        onClick: async () => {
          const slugs = [...document.querySelectorAll('#seasonList input:checked')].map((i) => i.value);
          if (!slugs.length) return toast('Seleziona almeno una stagione');
          closeModal();
          await commitAdd(slugs);
        },
      },
      {
        label: 'Tutte',
        secondary: true,
        onClick: async () => {
          closeModal();
          await commitAdd(seasons.map((s) => s.slug));
        },
      },
      { label: 'Annulla', secondary: true, onClick: closeModal },
    ],
  );
}

async function commitAdd(slugs) {
  toast(`Aggiungo ${slugs.length > 1 ? `${slugs.length} stagioni` : 'la serie'}…`);
  try {
    const { push } = await api('add', { slugs });
    await load();
    if (push?.serverDown) {
      askServer(push.error);
      return;
    }
    toast('Serie aggiunta e feed inviato');
  } catch (e) {
    if (e.serverDown) {
      await load();
      askServer(e.message);
      return;
    }
    toast(`Errore: ${e.message}`);
  }
}

// --- profilo pubblico ---------------------------------------------------

const dayMonth = (date) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  return m ? `${m[3]}/${m[2]}` : '';
};

function renderAccount() {
  const el = $('#accountState');
  const cfg = String(st.settings.accountProfile || '').trim();
  const a = st.account;
  if (!cfg) {
    el.textContent = 'Profilo AnimeSaturn: non configurato (impostalo in ⚙) — senza profilo restano solo ricerca e URL.';
    return;
  }
  if (!a) {
    el.textContent = `Profilo ${cfg}: mai importato. Premi “Importa profilo”.`;
    return;
  }
  const when = a.at ? new Date(a.at).toLocaleString('it-IT') : '';
  el.textContent = `Profilo ${a.name || a.id} · watchlist ${a.watchlist?.length || 0} · preferiti ${a.favorites?.length || 0}${a.truncated ? ' · lista troncata a 200 voci' : ''}${when ? ` · importato ${when}` : ''}`;
}

function renderOutings() {
  const a = st.account || {};
  const now = Date.now();
  const future = [];
  const past = [];
  for (const e of a.calendar || []) {
    if (!st.series[e.slug]) continue;
    const ts = calendarTs(e);
    if (!ts) continue;
    (ts + 3 * 3600e3 >= now ? future : past).push({ ...e, ts });
  }
  future.sort((x, y) => x.ts - y.ts);
  past.sort((x, y) => y.ts - x.ts);

  const badge = $('#outingsBadge');
  badge.textContent = future.length ? String(future.length) : '';
  badge.hidden = !future.length;

  const row = (e) => `<div class="q">
      <div>${esc(e.title)} <small>Ep ${e.ep}</small><br>
      <small>${esc(e.day || '')} ${dayMonth(e.date)}${e.time ? ` · ${esc(e.time)}` : ''}</small></div>
    </div>`;

  $('#calendarList').innerHTML = [...future, ...past].map(row).join('') ||
    `<p class="hint">${a.id ? 'Nessuna puntata in calendario per le serie che segui: premi “Aggiorna uscite”.' : 'Importa il profilo per vedere le uscite della settimana.'}</p>`;

  const recent = (a.recent || []).filter((x) => st.series[x.slug]);
  $('#recentList').innerHTML = recent
    .map((x) => `<div class="q">
      <div>${esc(st.series[x.slug].title)} <small>Ep ${x.n}</small><br>
      <small>${new Date(x.pubDate).toLocaleString('it-IT')}</small></div>
    </div>`)
    .join('') || '<p class="hint">Nessuna uscita recente registrata.</p>';

  const at = a.calendarAt ? new Date(a.calendarAt).toLocaleString('it-IT') : 'mai';
  $('#calendarState').textContent = `Calendario aggiornato: ${at} · si rinnova insieme all'aggiornamento dei preferiti.`;
}

// Modale "Dal profilo": serie da aggiungere ai preferiti locali.
function openProfileModal(acc) {
  const already = new Set(Object.keys(st.series));
  const rows = [...(acc.watchlist || [])];
  const inWl = new Set(rows.map((r) => r.slug));
  for (const f of acc.favorites || []) {
    if (!inWl.has(f.slug)) rows.push({ ...f, badge: 'Preferito', watched: 0, total: null });
  }
  const fresh = rows.filter((r) => !already.has(r.slug));

  if (!fresh.length) {
    toast('Tutte le serie del profilo sono già nei preferiti');
    return;
  }

  const html = fresh
    .map(
      (r) => `<label class="season">
        <input type="checkbox" value="${esc(r.slug)}" checked>
        <span><strong>${esc(r.title)}</strong>${r.badge ? ` · ${esc(r.badge)}` : ''}<br>
        <small>${r.total != null ? `Episodi ${r.watched || 0}/${r.total}` : 'Episodi non indicati'}${r.siteStatus ? ` · ${esc(r.siteStatus)}` : ''}</small></span>
      </label>`,
    )
    .join('');

  openModal(
    `Dal profilo di ${acc.name || acc.id}`,
    `<p class="hint">${fresh.length} serie da aggiungere ai preferiti. Quelle con episodi già visti vengono
     segnate come viste (solo se non hai già segnato qualcosa a mano).</p>
     <div id="profileList">${html}</div>`,
    [
      {
        label: 'Aggiungi selezionate',
        onClick: async () => {
          const slugs = [...document.querySelectorAll('#profileList input:checked')].map((i) => i.value);
          if (!slugs.length) return toast('Seleziona almeno una serie');
          closeModal();
          await commitProfile(slugs);
        },
      },
      {
        label: 'Tutte',
        secondary: true,
        onClick: async () => {
          closeModal();
          await commitProfile(fresh.map((r) => r.slug));
        },
      },
      { label: 'Annulla', secondary: true, onClick: closeModal },
    ],
  );
}

async function saveList(slug, format) {
  closeModal();
  toast('Risolvo gli URL…');
  try {
    const res = await api('exportList', { slug, format });
    toast(`Lista ${format}: ${res.count}/${res.total} episodi in ${res.name}`);
  } catch (e) {
    toast(`Errore: ${e.message}`);
  }
}

async function commitProfile(slugs) {
  toast(`Aggiungo ${slugs.length > 1 ? `${slugs.length} serie` : 'la serie'}…`);
  try {
    const { push } = await api('accountAdd', { slugs });
    await load();
    if (push?.serverDown) return askServer(push.error);
    toast('Serie importate e feed inviato');
  } catch (e) {
    if (e.serverDown) {
      await load();
      return askServer(e.message);
    }
    toast(`Errore: ${e.message}`);
  }
}

// --- suggerimenti stagioni ----------------------------------------------

function openSeasonModal(groups) {
  const rows = groups
    .map(
      (g) => `<p class="hint"><strong>${esc(g.name)}</strong></p>` +
        g.seasons
          .map((s) => {
            const meta = [
              `${s.aired ?? '?'}${s.total && s.total !== s.aired ? `/${s.total}` : ''} episodi`,
              s.status,
              s.inWatchlist ? 'nella watchlist' : '<strong>non nella watchlist</strong>',
            ]
              .filter(Boolean)
              .join(' · ');
            return `<label class="season">
              <input type="checkbox" value="${esc(s.slug)}" checked>
              <span><strong>Stagione ${s.season}</strong> — ${esc(s.title)}<br>
              <small>${meta}</small></span>
            </label>`;
          })
          .join(''),
    )
    .join('');

  openModal(
    'Stagioni che non hai ancora',
    `<p class="hint">Trovate cercando nella famiglia di ogni serie già nei preferiti.</p>${rows}`,
    [
      {
        label: 'Aggiungi selezionate',
        onClick: async () => {
          const slugs = [...document.querySelectorAll('#modalBody input:checked')].map((i) => i.value);
          if (!slugs.length) return toast('Seleziona almeno una stagione');
          closeModal();
          await commitAdd(slugs);
        },
      },
      { label: 'Chiudi', secondary: true, onClick: closeModal },
    ],
  );
}

// --- sbircia un profilo (senza importare) -------------------------------

function renderPeek(acc) {
  const rows = (acc.watchlist || [])
    .map(
      (r) => `<div class="q">
        <div>${esc(r.title)} <small>${esc(r.badge)}</small><br>
        <small>${r.type ? `${esc(r.type)} · ` : ''}${r.year || ''}${r.total != null ? ` · Episodi ${r.watched}/${r.total}` : ''}</small></div>
      </div>`,
    )
    .join('');
  const favs = (acc.favorites || []).map((f) => esc(f.title)).join(' · ') || 'nessuno';

  $('#peekResult').innerHTML = `
    <div class="peek">
      <p><strong>${esc(acc.name || `profilo ${acc.id}`)}</strong> <small>id ${esc(acc.id)}</small><br>
      <small>watchlist ${acc.watchlist?.length || 0}${acc.truncated ? ' (troncata)' : ''} · preferiti ${acc.favorites?.length || 0}</small></p>
      <p class="hint">Preferiti: ${favs}</p>
      ${rows || '<p class="hint">Watchlist vuota o non pubblica.</p>'}
      <p class="hint">Sola lettura: niente è stato aggiunto ai tuoi preferiti.</p>
    </div>`;
}

// --- ricerca ------------------------------------------------------------

$('#searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#results').innerHTML = '<p class="hint">Cerco…</p>';
  try {
    const results = await api('search', { q });
    $('#results').innerHTML = results
      .map(
        (r) => `<div class="q">
          <div>${esc(r.title)}<br><small>${esc(r.year)} · ${r.episodes || '?'} ep · ${esc(r.status)}</small></div>
          <button data-act="add" data-url="${esc(r.url)}">+</button>
        </div>`,
      )
      .join('') || '<p class="hint">Nessun risultato.</p>';
  } catch (e) {
    toast(e.message);
  }
});

$('#urlForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const url = $('#url').value.trim();
  if (!url) return;
  await addFlow(url);
});

$('#peekForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#peek').value.trim();
  if (!input) return;
  $('#peekResult').innerHTML = '<p class="hint">Guardo il profilo…</p>';
  try {
    renderPeek(await api('peek', { input }));
  } catch (e) {
    $('#peekResult').innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
});

// --- azioni -------------------------------------------------------------

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn || btn.disabled) return;
  const { act, slug, n, id, url } = btn.dataset;

  try {
    switch (act) {
      case 'toggle':
        open.has(slug) ? open.delete(slug) : open.add(slug);
        fillEps(slug);
        return;
      case 'add':
        await addFlow(url);
        return;
      case 'new': {
        const aired = st.series[slug]?.airedEps || 0;
        const seen = new Set(st.seen[slug] || []);
        const ns = (st.episodes[slug] || []).filter((e) => e.n <= aired && !seen.has(e.n)).map((e) => e.n);
        if (!ns.length) return toast('Nessun episodio nuovo');
        await api('download', { slug, ns });
        await load();
        return toast(`${ns.length} episodi in coda`);
      }
      case 'dlSelected': {
        const ns = [...document.querySelectorAll(`[data-eps="${CSS.escape(slug)}"] input[data-pick]:checked`)].map((i) => Number(i.value));
        if (!ns.length) return toast('Seleziona almeno un episodio');
        await api('download', { slug, ns });
        await load();
        return toast(`${ns.length} episodi in coda`);
      }
      case 'selectAll':
        for (const i of document.querySelectorAll(`[data-eps="${CSS.escape(slug)}"] input[data-pick]:not([disabled])`)) i.checked = true;
        return;
      case 'dlEp':
        await api('download', { slug, ns: [Number(n)] });
        await load();
        return toast(`Ep ${n} in coda`);
      case 'seen':
        await api('seen', { slug, n: Number(n), value: btn.dataset.value === '1' });
        await load();
        return;
      case 'list': {
        const title = st.series[slug]?.title || slug;
        openModal(
          'Salva la lista URL',
          `<p>${esc(title)}</p>
           <p class="hint">Il file contiene gli URL diretti risolti adesso: scadono dopo qualche ora,
           quindi rigeneralo se il download non parte.</p>`,
          [
            { label: 'aria2 (.txt)', onClick: () => saveList(slug, 'aria2') },
            { label: 'yt-dlp (.txt)', secondary: true, onClick: () => saveList(slug, 'ytdlp') },
            { label: 'Annulla', secondary: true, onClick: closeModal },
          ],
        );
        return;
      }
      case 'remove':
        if (!confirm('Rimuovere la serie dai preferiti?')) return;
        await api('remove', { slug });
        open.delete(slug);
        await load();
        return;
      case 'refreshAll':
        toast('Aggiorno…');
        await api('refresh', {});
        await load();
        return toast('Aggiornato');
      case 'seasonSuggestions': {
        toast('Cerco le stagioni mancanti…');
        let groups;
        try {
          groups = await api('seasonSuggestions');
        } catch (e) {
          return toast(`Errore: ${e.message}`);
        }
        if (!groups.length) return toast('Nessuna stagione mancante trovata');
        return openSeasonModal(groups);
      }
      case 'openFeed':
        return webext.tabs.create({ url: 'http://127.0.0.1:8787/feed.xml' });
      case 'pushFeed':
        try {
          await api('pushFeed', { force: true });
          await load();
          return toast('Feed inviato al server');
        } catch (e) {
          if (e.serverDown) return askServer(e.message);
          throw e;
        }
      case 'options':
        return webext.runtime.openOptionsPage();
      case 'importProfile': {
        toast('Leggo il profilo pubblico…');
        let acc;
        try {
          acc = await api('accountImport');
        } catch (e) {
          return toast(`Errore: ${e.message}`);
        }
        await load();
        openProfileModal(acc);
        return;
      }
      case 'refreshCalendar':
        toast('Aggiorno le uscite…');
        try {
          await api('calendarRefresh');
        } catch (e) {
          return toast(`Errore: ${e.message}`);
        }
        await load();
        return toast('Uscite aggiornate');
      case 'expand':
        return webext.tabs.create({ url: webext.runtime.getURL('popup.html?tab=1') });
      case 'retry':
        await api('retry', { slug, n: Number(n) });
        await load();
        return;
      case 'cancel':
        await api('cancel', { id });
        await load();
        return;
      case 'clearQueue':
        await api('clearQueue');
        await load();
        return;
    }
  } catch (e) {
    toast(`Errore: ${e.message}`);
  }
});

load().catch((e) => toast(`Errore: ${e.message}`));
