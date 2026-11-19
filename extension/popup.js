const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

let st = { series: {}, episodes: {}, seen: {}, queue: {}, news: {}, settings: {} };

async function api(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (!r) throw new Error('nessuna risposta dal service worker');
  if (!r.ok) throw new Error(r.error);
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

// --- rendering ----------------------------------------------------------

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
  // mantiene aperte le liste già espanse
  for (const slug of open) fillEps(slug);
}

const open = new Set();

function fillEps(slug) {
  const box = document.querySelector(`[data-eps="${CSS.escape(slug)}"]`);
  if (!box) return;
  const series = st.series[slug];
  const eps = [...(st.episodes[slug] || [])].sort((a, b) => b.n - a.n);
  const seen = new Set(st.seen[slug] || []);
  const aired = series?.airedEps || 0;

  box.hidden = !open.has(slug);
  if (box.hidden) return;

  const rows = eps.map(
    (e) => `
      <div class="ep ${seen.has(e.n) ? 'seen' : ''}">
        <label><input type="checkbox" data-pick="${e.n}" value="${e.n}"> <span class="n">Ep ${e.n}</span>${e.n > aired ? ' <small>(attesa)</small>' : ''}</label>
        <button data-act="seen" data-slug="${esc(slug)}" data-n="${e.n}" data-value="${seen.has(e.n) ? 0 : 1}">${seen.has(e.n) ? '↺' : '✓'}</button>
        <button data-act="dlEp" data-slug="${esc(slug)}" data-n="${e.n}">↓</button>
      </div>`,
  );

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
    const retry = q.state === 'error' ? `<button data-act="retry" data-id="${q.downloadId ?? i}" data-slug="${esc(q.slug)}" data-n="${q.n}">Riprova</button>` : '';
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
  await add(url);
});

async function add(url) {
  toast('Aggiungo…');
  try {
    await api('add', { url });
    await load();
    toast('Serie aggiunta');
  } catch (e) {
    toast(`Errore: ${e.message}`);
  }
}

// --- azioni -------------------------------------------------------------

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, slug, n, id, url } = btn.dataset;

  try {
    switch (act) {
      case 'toggle': {
        if (open.has(slug)) open.delete(slug);
        else open.add(slug);
        fillEps(slug);
        return;
      }
      case 'add':
        await add(url);
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
        for (const i of document.querySelectorAll(`[data-eps="${CSS.escape(slug)}"] input[data-pick]`)) i.checked = true;
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
        return chrome.tabs.create({ url: 'http://127.0.0.1:8787/feed.xml' });
      case 'writeFeed':
        await api('writeFeed');
        await load();
        return toast('feed.xml riscritto in Download');
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
