// Helper minimi di parsing: il service worker non ha DOMParser, quindi regex + JSON.

const ENTITIES = {
  '&quot;': '"',
  '&amp;': '&',
  '&#39;': "'",
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

// Una sola passata: "&amp;quot;" resta "&quot;", niente doppia decodifica.
export function decodeEntities(s) {
  return String(s).replace(/&(quot|amp|#39|apos|lt|gt|nbsp);/g, (m) => ENTITIES[m]);
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
