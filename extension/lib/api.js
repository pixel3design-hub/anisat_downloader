// Chrome / Chromium / Edge / Brave: chrome.* (in MV3 le API principali tornano Promise).
// Firefox: browser.* è promise-based; chrome.* esiste ma è basato su callback.
// Uso: import { api } from './lib/api.js'; poi api.storage.local.get(...)
export const api = globalThis.browser?.runtime ? globalThis.browser : globalThis.chrome;
