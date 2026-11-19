import { api as webext } from './lib/api.js';
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

let st = { series: {}, episodes: {}, seen: {}, queue: [], news: {}, settings: {}, feedState: {} };

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

function seriesCard(s) {
  const news = st.news[s.slug] || 0;
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.slug = s.slug;
  el.innerHTML = `
    <img src="${esc(s.poster)}" alt="" loading="lazy">
    <div>
      <h3>${esc(s.title)}${news ? `<span class="badge">${news}</span>` : ''}</h3>
      <p>${s.airedEps}/${s.totalEps} episodi · ${esc(s.status || '')}</p>
    </div>
    <div class="actions">
      <button data-act="toggle" data-slug="${esc(s.slug)}">Episodi</button>
      <button data-act="new" data-slug="${esc(s.slug)}">Scarica nuovi</button>
      <button data-act="list" data-slug="${esc(s.slug)}">Lista file</button>
      <button data-act="remove" data-slug="${esc(s.slug)}">✕</button>
    </div>
    <div class="eps" data-eps="${esc(s.slug)}" hidden></div>`;
  return el;
}

function renderSeries() {
  const list = Object.values(st.series).sort((a, b) => a.title.localeCompare(b.title));
  const box = $('#seriesList');
  box.replaceChildren(...list.map(seriesCard));
  $('#emptyHint').hidden = list.length > 0;
  for (const slug of open) fillEps(slug);

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
    const state = q.state === 'done' ? '✓' : q.state === 'downloading' ? '…' : q.state === 'error' ? '⚠' : '·';
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
}

async function load() {
  st = await api('state');
  render();
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
        toast('Risolvo gli URL…');
        const res = await api('exportList', { slug });
        return toast(`Lista pronta: ${res.count} episodi`);
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
