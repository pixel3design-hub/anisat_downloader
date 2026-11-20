// Sezioni e famiglie della lista serie per la UI.
// La famiglia viene dai "correlati" del sito (non dal titolo: spin-off e archi
// hanno titoli diversi), lo stato dalla watchlist del profilo.

import { parseTitle } from '../sites/animesaturn.js';

export const STATUS_GROUPS = [
  { key: 'watching', label: 'In corso' },
  { key: 'planned', label: 'Da guardare' },
  { key: 'paused', label: 'In pausa' },
  { key: 'completed', label: 'Completate' },
  { key: 'dropped', label: 'Droppati' },
  { key: 'none', label: 'Senza stato' },
];

// etichette che il sito usa nei badge della watchlist
const BY_LABEL = {
  'in corso': 'watching',
  'da guardare': 'planned',
  'in pausa': 'paused',
  completati: 'completed',
  completato: 'completed',
  droppati: 'dropped',
  droppato: 'dropped',
};

export function statusKey(listStatus) {
  return BY_LABEL[String(listStatus || '').trim().toLowerCase()] || 'none';
}

const withSeason = (s) => ({ ...s, season: parseTitle(s.title || s.slug || '').season });

// [{ key, label, count, series: [{...serie, season}] }]
export function statusSections(list = []) {
  const sections = STATUS_GROUPS.map((g) => ({ ...g, count: 0, series: [] }));
  for (const s of list) {
    const section = sections.find((g) => g.key === statusKey(s.listStatus));
    section.series.push(withSeason(s));
    section.count++;
  }
  for (const section of sections) section.series.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return sections.filter((s) => s.count);
}

// Divide le serie fra "con più stagioni" (tendina) e sezioni per stato.
// families: [{ key, title, slugs }] dai correlati del sito.
// Una serie in famiglia non compare anche nella sezione di stato (sarebbe un doppione).
export function buildView(list = [], families = []) {
  const groupOf = new Map();
  for (const f of families) for (const slug of f.slugs || []) groupOf.set(slug, f);

  const byFamily = new Map();
  const single = [];
  for (const s of list) {
    const f = groupOf.get(s.slug);
    if (!f) {
      single.push(s);
      continue;
    }
    if (!byFamily.has(f.key)) byFamily.set(f.key, { key: f.key, title: f.title, series: [] });
    byFamily.get(f.key).series.push(withSeason(s));
  }

  const multi = [];
  for (const fam of byFamily.values()) {
    fam.series.sort((a, b) => (a.season || 1) - (b.season || 1) || (a.title || '').localeCompare(b.title || ''));
    // una sola stagione in lista: nessun motivo per la tendina
    if (fam.series.length > 1) multi.push(fam);
    else single.push(...fam.series);
  }
  multi.sort((a, b) => a.title.localeCompare(b.title));

  return { multi, sections: statusSections(single) };
}

// stagioni del sito che non sono nei preferiti locali
export function missingSeasons(family = [], localSlugs = []) {
  const have = new Set(localSlugs);
  return family.filter((f) => f.slug && !have.has(f.slug));
}
