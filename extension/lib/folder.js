// Cartella di download scelta una volta sola (File System Access API).
// Il permesso si chiede al primo utilizzo; dopo, i file vengono scritti lì senza
// più passare dal dialogo "salva con nome" del browser.

const DB_NAME = 'anisat-fs';
const STORE = 'handles';
const KEY = 'downloads-dir';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out?.result ?? out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getDir() {
  try {
    const h = await withStore('readonly', (s) => s.get(KEY));
    return h || null;
  } catch {
    return null;
  }
}

export async function setDir(handle) {
  await withStore('readwrite', (s) => s.put(handle, KEY));
}

export async function clearDir() {
  await withStore('readwrite', (s) => s.delete(KEY));
}

// 'granted' | 'prompt' | 'denied'
export async function permission(handle) {
  if (!handle?.queryPermission) return 'denied';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

// Va chiamata solo da una pagina con un gesto dell'utente (popup/opzioni).
export async function requestPermission(handle) {
  if (!handle?.requestPermission) return 'denied';
  try {
    return await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

export async function pickDir() {
  const handle = await window.showDirectoryPicker({ id: 'anisat-downloads', mode: 'readwrite', startIn: 'downloads' });
  await setDir(handle);
  return handle;
}

// "Serie X/Serie X - Ep 01.mp4" -> ["Serie X", "Serie X - Ep 01.mp4"]
export function splitPath(fullPath) {
  const parts = String(fullPath).split('/').map((p) => p.trim()).filter(Boolean);
  return { dirs: parts.slice(0, -1), name: parts.at(-1) || 'download.mp4' };
}

/**
 * Scarica `url` dentro `dirHandle` seguendo il percorso relativo `fullPath`.
 * Scrive in streaming, senza tenere il file in memoria.
 */
export async function writeStream(dirHandle, fullPath, url, onProgress) {
  const { dirs, name } = splitPath(fullPath);
  let target = dirHandle;
  for (const d of dirs) target = await target.getDirectoryHandle(d, { create: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length')) || 0;
  const writable = await (await target.getFileHandle(name, { create: true })).createWritable();

  try {
    const reader = res.body.getReader();
    let done = 0;
    let lastTick = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      await writable.write(value);
      done += value.byteLength;
      if (onProgress && (done - lastTick > 4 * 1024 * 1024 || done === total)) {
        lastTick = done;
        onProgress(done, total);
      }
    }
    await writable.close();
    onProgress?.(done, total);
    return { bytes: done, name };
  } catch (e) {
    try {
      await writable.abort();
    } catch {
      // lo stream era già chiuso
    }
    throw e;
  }
}
