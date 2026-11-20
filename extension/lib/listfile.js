// File di testo con gli URL di una serie, per i due strumenti da riga di comando.
// aria2 vuole "url + out=<percorso>", yt-dlp vuole un URL per riga e accetta
// le righe che iniziano con '#' come commenti.

const NOURL = (e) => `# ep ${e.n}: nessuna fonte utilizzabile (${e.error || 'solo HLS'})`;

// [{ n, url, hls, out, error }] -> testo per `aria2c -i lista.txt`
export function aria2List({ title, file = 'lista.txt', folder = 'AnimeSaturn', episodes = [] } = {}) {
  const lines = [
    `# ${title} - URL per aria2 (gli URL scadono: rigenera la lista se il download non parte)`,
    `# cd ~/Download && aria2c -c -i ${file}`,
    '',
  ];
  for (const e of episodes) {
    if (!e.url) {
      lines.push(e.hls ? `# ep ${e.n}: solo HLS (aria2 non lo scarica), usa la lista yt-dlp` : NOURL(e));
      continue;
    }
    lines.push(e.url);
    if (e.out) lines.push(`  out=${e.out}`);
  }
  return lines.join('\n') + '\n';
}

// [{ n, url, hls, error }] -> testo per `yt-dlp --batch-file lista.txt`
export function ytdlpList({ title, file = 'lista.txt', folder = 'AnimeSaturn', episodes = [] } = {}) {
  const lines = [
    `# ${title} - URL per yt-dlp (anche HLS)`,
    `# cd ~/Download && yt-dlp --batch-file ${file} -o "${folder}/${title}/%(title)s - ep %(autonumber)02d.%(ext)s"`,
    '',
  ];
  for (const e of episodes) {
    const url = e.url || e.hls;
    if (!url) {
      lines.push(NOURL(e));
      continue;
    }
    lines.push(`# ep ${e.n}`);
    lines.push(url);
  }
  return lines.join('\n') + '\n';
}

export const FORMATS = { aria2: aria2List, ytdlp: ytdlpList };
