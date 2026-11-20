// Sezioni e famiglie della lista serie per la UI.
// La sezione è lo stato nella watchlist del sito; dentro la sezione le stagioni
// della stessa serie restano vicine.

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

const familyKey = (s) => {
  const t = parseTitle(s.title || s.slug || '');
  return `${t.base}|${t.lang}`;
};

// [{ key, label, count, families: [{ key, title, seasons: [{...serie, season}] }] }]
export function groupSeries(list = []) {
  const sections = STATUS_GROUPS.map((g) => ({ ...g, count: 0, families: [] }));

  for (const s of list) {
    const section = sections.find((g) => g.key === statusKey(s.listStatus));
    const key = familyKey(s);
    let fam = section.families.find((f) => f.key === key);
    if (!fam) {
      fam = { key, title: s.title || s.slug, seasons: [] };
      section.families.push(fam);
    }
    fam.seasons.push({ ...s, season: parseTitle(s.title || s.slug || '').season });
    section.count++;
  }

  for (const section of sections) {
    section.families.sort((a, b) => a.title.localeCompare(b.title));
    for (const fam of section.families) fam.seasons.sort((a, b) => a.season - b.season);
  }
  return sections.filter((s) => s.count);
}

// stagioni del sito che non sono nei preferiti locali
export function missingSeasons(family = [], localSlugs = []) {
  const have = new Set(localSlugs);
  return family.filter((f) => f.slug && !have.has(f.slug));
}
