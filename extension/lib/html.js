// Helper minimi di parsing: il service worker non ha DOMParser, quindi regex + JSON.

const NAMED = { quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ' };

// Una sola passata: "&amp;quot;" resta "&quot;", niente doppia decodifica.
// Gestisce anche le entità numeriche (&#039; capita nei titoli).
export function decodeEntities(s) {
  return String(s).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED[e] ?? m;
  });
}

export function firstMatch(re, s) {
  const m = re.exec(String(s));
  return m ? (m[1] ?? m[0]) : null;
}

export function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  for (const m of String(html).matchAll(re)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // blocco non parsabile: ignorato
    }
  }
  return out;
}

// base64 -> XOR con chiave ripetuta (schema usato da play.saturncdn.net)
export function xorDecode(b64, key) {
  const bin = atob(b64);
  let out = '';
  for (let i = 0; i < bin.length; i++) {
    out += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return out;
}
