/* BF list vs eMag — static catalog. No backend: data/ chunks + localStorage + IndexedDB. */
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fmtNum = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lei = v => v == null || isNaN(v) ? '—' : fmtNum.format(v) + ' lei';
const pct = v => v == null || isNaN(v) ? '—' : (v > 0 ? '−' : '+') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0) + '%';
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 9);

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { toast('Browser storage is full or blocked: ' + e.message); }
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---------------------------------------------------------------- persistent state
const DEFAULT_PROXIES = [
  'https://api.allorigins.win/raw?url={url}',
  'https://corsproxy.io/?url={url}',
  'https://api.codetabs.com/v1/proxy/?quest={url}',
];
const settings = Object.assign({
  proxies: DEFAULT_PROXIES, lastProxy: 0, source: 'auto', localPort: 8787,
  autoFetch: true, deep: true, concurrency: 3, ttlHours: 72, theme: 'system', v: 4,
}, load('el.settings', {}));
const saveSettings = () => save('el.settings', settings);
// v2 switched auto-loading off because every card ever appended kept its own request slot and the
// public proxies answered 400/500 by the hundred. v3 loads on demand instead: only the rows the
// virtual scroller is showing are ever queued, so the request budget is one screen, not the catalog.
if ((settings.v | 0) < 3) { settings.autoFetch = true; settings.v = 3; saveSettings(); }
// v4 stops leading with the public proxies: every one of them was answering with an error or
// nothing at all, so the device itself asks eMag now and the proxies are only the fallback.
if ((settings.v | 0) < 4) { settings.source = 'auto'; settings.localPort = 8787; settings.v = 4; saveSettings(); }

let wishlists = load('el.wishlists', null) || { lists: [{ id: uid(), name: 'My wishlist', budget: null, items: [] }], active: null };
if (!wishlists.active) wishlists.active = wishlists.lists[0]?.id;
const saveWL = () => { save('el.wishlists', wishlists); updateBadges(); };
let compare = load('el.compare', []);
const saveCmp = () => { save('el.compare', compare); updateBadges(); renderDock(); };
const userTags = load('el.userTags', {});     // id -> [tag]
const overrides = load('el.overrides', {});   // id -> {url, price}
const saveUT = () => save('el.userTags', userTags);
const saveOV = () => save('el.overrides', overrides);

const DEFAULT_FILTERS = { q: '', sort: 'order', tagMode: 'any', inc: [], exc: [], brand: '', pMin: '', pMax: '', hasEmag: false, cheaper: false, dMin: '', dMax: '', lMin: '', lMax: '', inList: '' };
const F = Object.assign({}, DEFAULT_FILTERS, load('el.filters', {}));
const saveF = () => save('el.filters', F);

// ---------------------------------------------------------------- IndexedDB cache for eMag data
const cache = new Map();
let db;
function openDB() {
  return new Promise(res => {
    try {
      const r = indexedDB.open('emaglist', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('emag');
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => res();
    } catch { res(); }
  });
}
function loadCache() {
  return new Promise(res => {
    if (!db) return res();
    const tx = db.transaction('emag', 'readonly'), st = tx.objectStore('emag');
    const req = st.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { cache.set(c.key, c.value); c.continue(); } else res(); };
    req.onerror = () => res();
  });
}
function putCache(id, val) {
  cache.set(id, val);
  if (!db) return;
  try { db.transaction('emag', 'readwrite').objectStore('emag').put(val, id); } catch {}
}
function clearCache() {
  cache.clear();
  if (db) try { db.transaction('emag', 'readwrite').objectStore('emag').clear(); } catch {}
  ITEMS.forEach(it => (it._tags = it._hay = null));
}

// ---------------------------------------------------------------- catalog, fetched in chunks
// The full list is 3.5 MB of JSON and three quarters of that is product names, so downloading all
// of it to draw twenty-four cards was the whole of the wait. data/index.json carries the tag and
// brand vocabularies and the product count -- enough to lay every row out at the right height --
// and each data/cN.json holds 250 products, fetched when the scroller reaches them. Searching,
// filtering and sorting look across the whole list, so those pull the rest in first.
const DATA_DIR = 'data/';
let CHUNK = 250, CHUNKS = 0, FIRST_ID = 1, chunkState = [], loadingAll = false;
const chunkOfRow = i => Math.floor(i / CHUNK);
const chunkOfId = id => Math.floor((id - FIRST_ID) / CHUNK);
const haveAll = () => CHUNKS > 0 && chunkState.every(v => v === 2);
// a row nobody has downloaded yet still draws a card, so the scrollbar and the row height stay
// honest before its chunk lands; the negative id keeps it out of BY_ID and the wishlists
const placeholder = i => ({ id: -1 - i, name: '', price: null, brand: '', base: [], pending: true });

async function loadIndex() {
  const r = await fetch(DATA_DIR + 'index.json');
  if (!r.ok) throw new Error('data/index.json is missing. Run: node tools/split-data.js');
  const ix = await r.json();
  BASE_TAGS = ix.tags; BRANDS = ix.brands;
  TAG_SEED = ix.tags.map((t, i) => [t, ix.counts[i]]);
  CHUNK = ix.chunk; CHUNKS = ix.chunks; FIRST_ID = ix.firstId;
  CHUNK_CACHE = 'emaglist-data-' + (ix.v || '1');
  chunkState = new Array(CHUNKS).fill(0);
  ITEMS = new Array(ix.count);
  for (let i = 0; i < ix.count; i++) ITEMS[i] = placeholder(i);
}

// Chunks are kept on disk once fetched, so scrolling back over ground you have already covered --
// or reloading the page tomorrow -- costs nothing. Only chunks actually fetched are stored, so
// this never adds up to the big download it replaced. Cache Storage needs a secure origin, which
// github.io and localhost both are; anywhere else this quietly falls back to the network.
let CHUNK_CACHE = '', chunkStore;
async function openChunkStore() {
  if (chunkStore !== undefined) return chunkStore;
  try {
    chunkStore = await caches.open(CHUNK_CACHE);
    const stale = (await caches.keys()).filter(k => k.startsWith('emaglist-data-') && k !== CHUNK_CACHE);
    stale.forEach(k => caches.delete(k));
  } catch { chunkStore = null; }
  return chunkStore;
}
async function fetchChunk(url) {
  const store = await openChunkStore();
  if (store) {
    const hit = await store.match(url).catch(() => null);
    if (hit) return hit;
  }
  const r = await fetch(url);
  if (r.ok && store) store.put(url, r.clone()).catch(() => {});
  return r;
}

const chunkWait = new Map();
function loadChunk(k) {
  if (chunkState[k] === 2) return Promise.resolve(false);
  if (chunkWait.has(k)) return chunkWait.get(k);
  const p = (async () => {
    try {
      const r = await fetchChunk(DATA_DIR + 'c' + k + '.json');
      if (!r.ok) throw new Error('chunk ' + k + ' is missing');
      const rows = await r.json(), at = k * CHUNK;
      for (let j = 0; j < rows.length; j++) {
        const [id, name, price, b, t] = rows[j];
        const it = { id, name, price, brand: b >= 0 ? BRANDS[b] : '', base: t.map(i => BASE_TAGS[i]) };
        ITEMS[at + j] = it; BY_ID.set(id, it);
      }
      chunkState[k] = 2;
      return true;
    } catch { chunkState[k] = 0; return false; }
    finally { chunkWait.delete(k); }
  })();
  chunkState[k] = 1; chunkWait.set(k, p);
  return p;
}

// what the virtual scroller is showing is what gets downloaded
function ensureRows(from, to) {
  const a = chunkOfRow(Math.max(0, from)), b = chunkOfRow(Math.max(0, to - 1));
  const jobs = [];
  for (let k = a; k <= b && k < CHUNKS; k++) if (chunkState[k] !== 2) jobs.push(loadChunk(k));
  if (jobs.length) Promise.all(jobs).then(got => got.some(Boolean) && catalogGrew());
}
// A screen of lookahead, in the direction you are scrolling: by the time those rows reach the
// viewport their chunk is already in, so they arrive with their names and prices rather than as
// grey bars. Scroll the other way and the lookahead turns round with you.
let lastFirst = 0;
function prefetchAhead(first, last) {
  if (CHUNKS === 0) return;
  const span = Math.max(1, last - first + 1);
  const down = first >= lastFirst;
  lastFirst = first;
  const fromRow = down ? last + 1 : Math.max(0, first - span);
  const toRow = down ? last + span : Math.max(0, first - 1);
  if (toRow < fromRow) return;
  // A chunk holds 250 products, far more than the twenty-odd on screen, so a screen of lookahead
  // usually lands inside the chunk already loaded. The chunk past it is the one a continuous scroll
  // runs into next, and 26 KB is a cheap price for never meeting grey bars on the way.
  const lo = chunkOfRow(fromRow * cols), hi = chunkOfRow((toRow + 1) * cols - 1);
  const edge = down ? hi + 1 : lo - 1;
  for (let k = Math.min(lo, edge); k <= Math.max(hi, edge) && k < CHUNKS; k++)
    if (k >= 0 && chunkState[k] !== 2) loadChunk(k);
}

async function ensureIds(ids) {
  const ks = [...new Set(ids.map(chunkOfId))].filter(k => k >= 0 && k < CHUNKS && chunkState[k] !== 2);
  if (!ks.length) return false;
  return (await Promise.all(ks.map(loadChunk))).some(Boolean);
}
function catalogGrew() {
  if ($('#view-catalog').hidden) return;
  RESULTS = filtered();
  renderWindow(true);
  updateCountNow();
}

const wholeListNeeded = () => !!(F.q.trim() || F.inc.length || F.exc.length || F.brand.trim() || F.pMin || F.pMax ||
  F.dMin || F.dMax || F.lMin || F.lMax || F.hasEmag || F.cheaper || F.inList || F.sort !== 'order');
async function loadEverything() {
  if (loadingAll || haveAll()) return;
  loadingAll = true;
  const todo = [];
  for (let k = 0; k < CHUNKS; k++) if (chunkState[k] !== 2) todo.push(k);
  const total = todo.length;
  let done = 0;
  // the count line doubles as the progress bar; six at a time keeps the connection busy without
  // opening a hundred sockets on a phone
  const worker = async () => {
    for (;;) {
      const k = todo.shift();
      if (k === undefined) return;
      await loadChunk(k);
      done++;
      $('#count').innerHTML = 'Fetching the rest of the list to search it… <strong>' + Math.round(100 * done / total) + '%</strong>';
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  loadingAll = false;
}

// ---------------------------------------------------------------- data
let ITEMS = [], BY_ID = new Map(), BRANDS = [], BASE_TAGS = [];
const GROUP_TAGS = ['electronics', 'appliances', 'fashion', 'home', 'beauty-care', 'food-drinks', 'kids', 'sports', 'travel', 'tools', 'auto', 'gifts', 'men', 'women', 'unisex', 'sportswear', 'pets', 'health'];
const ICONS = [['phones', '📱'], ['tablets', '📱'], ['laptops', '💻'], ['pc', '🖥️'], ['tv-audio', '📺'], ['gaming', '🎮'], ['smartwatches', '⌚'], ['photo-video', '📷'], ['electronics', '🔋'], ['large-appliances', '🧺'], ['kitchen-appliances', '🍳'], ['cleaning', '🧹'], ['appliances', '🔌'], ['shoes', '👟'], ['clothing', '👕'], ['bags', '👜'], ['watches-jewelry', '⌚'], ['eyewear', '🕶️'], ['beauty', '💄'], ['fragrance', '🌸'], ['beauty-care', '🧴'], ['drinks', '🍷'], ['food', '☕'], ['toys', '🧸'], ['baby', '🍼'], ['pets', '🐾'], ['health', '💊'], ['tools', '🛠️'], ['auto', '🚗'], ['sports', '⚽'], ['travel', '🧳'], ['gifts', '🎁'], ['furniture', '🛋️'], ['home', '🏠'], ['books-office', '📚']];
const iconFor = it => { const t = new Set(it.base); for (const [k, e] of ICONS) if (t.has(k)) return e; return '🏷️'; };

function emagOf(it) {
  const c = cache.get(it.id), o = overrides[it.id];
  const price = o?.price != null ? o.price : (c?.ok ? c.price : null);
  return { c, price, url: o?.url || c?.url || null, img: c?.img || null, manual: o?.price != null };
}
function diffOf(it) {
  const e = emagOf(it).price;
  if (e == null || it.price == null || !e) return null;
  const d = e - it.price;
  return { d, p: (d / e) * 100, e };
}
function tagsOf(it) {
  if (it._tags) return it._tags;
  const s = new Set(it.base);
  (userTags[it.id] || []).forEach(t => s.add(t));
  const c = cache.get(it.id);
  if (c?.cats) c.cats.forEach(t => s.add('emag:' + t));
  it._tags = s;
  return s;
}
const hayOf = it => it._hay || (it._hay = norm(it.name + ' ' + it.brand + ' ' + [...tagsOf(it)].join(' ')));
const searchQuery = it => it.name.replace(/["'„”()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 10).join(' ').slice(0, 90);
const searchURL = it => 'https://www.emag.ro/search/' + encodeURIComponent(searchQuery(it));
const emagLink = it => emagOf(it).url || searchURL(it);

// ---------------------------------------------------------------- eMag fetching (via CORS proxy)
function isBlocked(html) {
  if (html.length < 600) return true;
  // Every normal eMag page ships EM.google_recaptcha_keys in its head, so the word 'captcha' on its
  // own used to condemn perfectly good pages. Product markup is the honest signal that one loaded.
  if (html.includes('card-item') || html.includes('product-new-price')) return false;
  return /are you a robot|access denied|cf-chl|attention required|<title>[^<]*captcha/i.test(html.slice(0, 6000));
}
let failStreak = 0, paused = false;

// Three ways to reach eMag, all but the last one running on this device.
//
// A page cannot read emag.ro itself: the browser makes the request but refuses to hand the reply to
// a script from another origin, and eMag sends nothing that would waive that. So something else on
// the machine has to ask and pass the answer in.
//   bridge   a userscript or the little extension in tools/ -- the request goes out of this browser,
//            from this address, and the bridge hands the page what came back. Nothing to run.
//   local    tools/emag-proxy.js listening on localhost, which fetches and answers with CORS headers.
//   proxies  somebody else's CORS proxy. Kept for the case where neither of the above is set up,
//            but all the public ones were failing when this was written, so it is no longer first.
let bridgeVia = '';
const bridgeWait = new Map();
let askId = 0;
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.emaglist === 'here') {
    const first = !bridgeVia;
    bridgeVia = d.via === 'extension' ? 'extension' : 'userscript';
    if (first) {
      paused = false; failStreak = 0;
      if (!$('#view-settings').hidden) renderSettings();
      syncWindowQueue();
    }
  } else if (d.emaglist === 'say' && bridgeWait.has(d.id)) {
    const w = bridgeWait.get(d.id); bridgeWait.delete(d.id);
    if (d.ok) w.ok(d.body || '');
    else w.err(new Error(d.error || ('eMag answered ' + (d.status || 'nothing'))));
  }
});
// the bridge loads before this script and says hello to nobody, so ask once it is listening
window.postMessage({ emaglist: 'ask', hello: true }, location.origin);

function viaBridge(url) {
  if (!bridgeVia) throw new Error('No userscript or extension on this page');
  return new Promise((ok, err) => {
    const id = ++askId;
    bridgeWait.set(id, { ok, err });
    setTimeout(() => { if (bridgeWait.delete(id)) err(new Error('Timed out')); }, 25000);
    window.postMessage({ emaglist: 'ask', id, url }, location.origin);
  });
}

const localBase = () => 'http://127.0.0.1:' + (settings.localPort || 8787);
let localOK = null, localProbe = null;
function probeLocal() {
  if (localProbe) return localProbe;
  localProbe = (async () => {
    try {
      const r = await fetch(localBase() + '/ping', { signal: AbortSignal.timeout(2500) });
      localOK = r.ok;
    } catch { localOK = false; }
    // it may be started after the page was opened, so the answer does not hold for long
    setTimeout(() => { localProbe = null; }, 20000);
    return localOK;
  })();
  return localProbe;
}
async function viaLocal(url) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(localBase() + '/?url=' + encodeURIComponent(url), { signal: ac.signal });
    if (!r.ok) throw new Error('The reader answered ' + r.status + ': ' + (await r.text()).slice(0, 80));
    localOK = true;
    return await r.text();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timed out');
    if (e instanceof TypeError) { localOK = false; localProbe = null; throw new Error('No answer from ' + localBase() + ' — not started, or this browser will not let the page reach it'); }
    throw e;
  } finally { clearTimeout(to); }
}

async function viaProxies(url) {
  const list = (settings.proxies || []).filter(Boolean);
  if (!list.length) throw new Error('No proxy set (Settings)');
  let last = 'All proxies failed';
  for (let k = 0; k < list.length; k++) {
    const i = (settings.lastProxy + k) % list.length;
    const full = list[i].replace('{url}', encodeURIComponent(url)).replace('{raw}', url);
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await fetch(full, { signal: ac.signal });
      clearTimeout(to);
      if (!r.ok) { last = 'Proxy returned ' + r.status; continue; }
      const text = await r.text();
      if (isBlocked(text)) { last = 'eMag blocked the request'; continue; }
      if (settings.lastProxy !== i) { settings.lastProxy = i; saveSettings(); }
      return text;
    } catch (e) { clearTimeout(to); last = e.name === 'AbortError' ? 'Timed out' : 'Network error'; }
  }
  throw new Error(last);
}

const SOURCE_NAMES = { bridge: 'the userscript or extension', local: 'this computer', proxies: 'a public proxy' };
let usedSource = '';
async function sourceOrder() {
  const src = settings.source || 'auto';
  if (src !== 'auto') return [src];
  const order = [];
  if (bridgeVia) order.push('bridge');
  if (await probeLocal()) order.push('local');
  if (!order.length) order.push('proxies');
  return order;
}
async function proxyFetch(url) {
  let last = '';
  for (const how of await sourceOrder()) {
    try {
      const text = how === 'bridge' ? await viaBridge(url) : how === 'local' ? await viaLocal(url) : await viaProxies(url);
      if (how !== 'proxies' && isBlocked(text)) throw new Error('eMag served a check page instead of the product');
      usedSource = how;
      return text;
    } catch (e) { last = SOURCE_NAMES[how] + ': ' + e.message; }
  }
  throw new Error(last || 'Nothing is set up to read eMag (Settings)');
}
const absUrl = u => !u ? null : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? 'https://www.emag.ro' + u : u;
function parsePriceEl(el) {
  if (!el) return null;
  const sup = el.querySelector('sup');
  if (sup) {
    const cents = sup.textContent.replace(/\D/g, '').slice(0, 2);
    const cl = el.cloneNode(true); $$('sup,span,s,del', cl).forEach(n => n.remove());
    const ints = cl.textContent.replace(/[^\d]/g, '');
    if (ints) return parseFloat(ints + '.' + (cents || '0'));
  }
  return parsePriceText(el.textContent);
}
function parsePriceText(t) {
  const m = String(t).replace(/\s/g, '').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
  return m ? parseFloat(m[1].replace(/\./g, '') + '.' + (m[2] || '0')) : null;
}
function jsonLd(doc) {
  const out = [];
  $$('script[type="application/ld+json"]', doc).forEach(s => {
    try { const j = JSON.parse(s.textContent); (Array.isArray(j) ? j : j['@graph'] || [j]).forEach(x => out.push(x)); } catch {}
  });
  return out;
}
function parseSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const res = [];
  const cards = $$('.card-item[data-url], .card-v2[data-url], [data-product-id][data-url], .card-item', doc);
  for (const c of cards) {
    const a = c.querySelector('a.card-v2-title, a.js-product-url, h2 a, a[href*="/pd/"]');
    const url = absUrl(c.dataset.url || a?.getAttribute('href'));
    if (!url || !/emag\.ro/.test(url)) continue;
    const title = (c.dataset.name || a?.textContent || a?.title || '').trim();
    const im = c.querySelector('img');
    const img = absUrl(im?.getAttribute('src')?.startsWith('data:') ? im?.dataset.src : (im?.getAttribute('src') || im?.dataset.src));
    const price = parsePriceEl(c.querySelector('.product-new-price'));
    const old = parsePriceEl(c.querySelector('.product-old-price s, .product-old-price, .rrp-lp30d-content'));
    res.push({ url: url.split('#')[0], title, img, price, old: old && price && old > price ? old : null });
  }
  if (!res.length) {
    for (const x of jsonLd(doc)) {
      const list = x['@type'] === 'ItemList' ? x.itemListElement : null;
      if (list) list.forEach(e => { const p = e.item || e; res.push({ url: p.url, title: p.name, img: Array.isArray(p.image) ? p.image[0] : p.image, price: num(p.offers?.price ?? p.offers?.lowPrice), old: null }); });
    }
  }
  return res.filter(r => r.url);
}
function parseProduct(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = { cats: [], props: [] };
  const meta = p => doc.querySelector(`meta[property="${p}"], meta[name="${p}"]`)?.content;
  out.title = meta('og:title') || doc.querySelector('h1')?.textContent?.trim();
  out.img = absUrl(meta('og:image'));
  out.price = num(meta('product:price:amount')) ?? parsePriceEl(doc.querySelector('.product-highlight .product-new-price, .product-page-pricing .product-new-price, .product-new-price'));
  for (const x of jsonLd(doc)) {
    if (x['@type'] === 'Product') {
      if (out.price == null) out.price = num(x.offers?.price ?? x.offers?.lowPrice ?? x.offers?.[0]?.price);
      if (!out.img) out.img = Array.isArray(x.image) ? x.image[0] : x.image;
      if (x.category) out.cats.push(...String(x.category).split(/[>/]/).map(s => s.trim()).filter(Boolean));
      (x.additionalProperty || []).forEach(p => p.name && out.props.push([p.name, String(p.value)]));
    }
    if (x['@type'] === 'BreadcrumbList') (x.itemListElement || []).forEach(e => out.cats.push(e.name || e.item?.name));
  }
  if (!out.cats.length) $$('.breadcrumb li, ol.breadcrumb a, nav[aria-label*="breadcrumb" i] a', doc).forEach(li => out.cats.push(li.textContent.trim()));
  const seen = new Set();
  out.cats = out.cats.filter(Boolean).map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length < 60 && !/^(emag|home|acasa|pagina principala)$/i.test(s) && s !== out.title && !seen.has(s) && seen.add(s));
  if (out.cats.length > 1 && out.title && norm(out.title).startsWith(norm(out.cats.at(-1)).slice(0, 20)) && out.cats.at(-1).length > 35) out.cats.pop();
  if (!out.props.length) {
    let rows = $$('#specification-section-content tr, .specifications-table tr, .product-page-specifications tr, [class*="specification"] tr', doc);
    if (!rows.length) rows = $$('table tr', doc).filter(r => r.children.length === 2);
    for (const r of rows) {
      const cells = [...r.children].map(c => c.textContent.replace(/\s+/g, ' ').trim());
      if (cells.length >= 2 && cells[0] && cells[1] && cells[0].length < 60) out.props.push([cells[0], cells.slice(1).join(' ')]);
      if (out.props.length >= 60) break;
    }
  }
  return out;
}
function tokens(s) { return norm(s).split(/[^a-z0-9]+/).filter(t => t.length > 1); }
function matchScore(it, title) {
  const theirs = new Set(tokens(title));
  const mine = tokens(it.name).slice(0, 14);
  let got = 0, tot = 0;
  for (const t of mine) {
    const w = /\d/.test(t) && /[a-z]/.test(t) ? 4 : /\d/.test(t) ? 1.5 : t === norm(it.brand) ? 3 : 1;
    tot += w; if (theirs.has(t)) got += w;
  }
  return tot ? got / tot : 0;
}
async function fetchEmag(it, { deep = settings.deep } = {}) {
  const o = overrides[it.id];
  const rec = { t: Date.now(), ok: false };
  try {
    let best = null;
    if (o?.url) {
      best = { url: o.url, score: 1 };
    } else {
      const list = parseSearch(await proxyFetch(searchURL(it)));
      if (!list.length) throw new Error('No results on eMag for this name');
      // eMag cannot be asked for a product by title, so this is the second of two calls: search by
      // name, take the result whose name matches ours exactly (usually the first one), and only fall
      // back to the best token score. Earlier results win a near-tie.
      const want = norm(it.name);
      // the list names are capped at 255 characters, so an eMag title can be our name plus more
      best = list.find(r => { const t = norm(r.title); return t === want || (want.length > 25 && (t.startsWith(want) || want.startsWith(t))); }) || null;
      if (best) best.score = 1;
      else list.slice(0, 12).forEach((r, i) => { r.score = matchScore(it, r.title) - i * 0.01; if (!best || r.score > best.score) best = r; });
    }
    Object.assign(rec, { url: best.url, title: best.title, img: best.img, price: best.price, old: best.old, score: +best.score.toFixed(2) });
    if (deep || best.price == null) {
      try {
        const p = parseProduct(await proxyFetch(best.url));
        rec.cats = p.cats.slice(0, 6); rec.props = p.props;
        if (p.price != null) rec.price = p.price;
        rec.img = rec.img || p.img; rec.title = rec.title || p.title; rec.deep = true;
      } catch (e) { if (rec.price == null) throw e; rec.deepErr = e.message; }
    }
    rec.ok = rec.price != null;
    if (!rec.ok) rec.err = 'No price found on the eMag page';
    failStreak = 0;
  } catch (e) {
    rec.err = e.message;
    if (/proxy|network|timed out|blocked|failed|listening|check page|not answering|did not answer/i.test(e.message)) failStreak++;
  }
  putCache(it.id, rec); it._tags = it._hay = null;
  if (failStreak >= 8 && settings.autoFetch && !paused) {
    paused = true;
    toast('eMag is not answering. Auto-loading paused; check Settings.');
  }
  return rec;
}
const fresh = it => { const c = cache.get(it.id); return c && (c.ok || c.err === 'No results on eMag for this name') && Date.now() - c.t < settings.ttlHours * 3600e3; };

// fetch queue with concurrency; visible cards first
const queue = []; const inflight = new Set();
// asked for by hand (detail sheet, refresh button, batch): kept in the queue even once the card
// scrolls out of the window
const pinned = new Set();
function enqueue(it, front = false) {
  if (front) pinned.add(it.id);
  if (inflight.has(it.id) || queue.includes(it)) return;
  front ? queue.unshift(it) : queue.push(it);
  pump();
}
function dequeue(it) { const i = queue.indexOf(it); if (i >= 0) queue.splice(i, 1); }
function pump() {
  while (inflight.size < Math.max(1, Math.min(6, settings.concurrency | 0)) && queue.length) {
    const it = queue.shift(); inflight.add(it.id); pinned.delete(it.id); refreshCard(it);
    fetchEmag(it).finally(() => { inflight.delete(it.id); refreshCard(it); refreshDetail(it); batchTick(); updateCount(); debCount(); pump(); });
  }
}

// ---------------------------------------------------------------- filtering & sorting
function filtered() {
  const qt = norm(F.q).split(/\s+/).filter(Boolean);
  const inc = F.inc, exc = F.exc, all = F.tagMode === 'all';
  const pMin = num(F.pMin), pMax = num(F.pMax), dMin = num(F.dMin), dMax = num(F.dMax), lMin = num(F.lMin), lMax = num(F.lMax);
  const needDiff = F.hasEmag || F.cheaper || dMin != null || dMax != null || lMin != null || lMax != null;
  const brand = norm(F.brand.trim());
  const list = F.inList ? new Set(wishlists.lists.find(l => l.id === F.inList)?.items || []) : null;
  const out = [];
  for (const it of ITEMS) {
    if (list && !list.has(it.id)) continue;
    if (brand && !norm(it.brand).includes(brand)) continue;
    if (pMin != null && (it.price == null || it.price < pMin)) continue;
    if (pMax != null && (it.price == null || it.price > pMax)) continue;
    if (inc.length || exc.length) {
      const t = tagsOf(it);
      if (exc.some(x => t.has(x))) continue;
      if (inc.length && !(all ? inc.every(x => t.has(x)) : inc.some(x => t.has(x)))) continue;
    }
    if (qt.length) { const h = hayOf(it); if (!qt.every(x => h.includes(x))) continue; }
    if (needDiff) {
      const d = diffOf(it);
      if (!d) continue;
      if (F.cheaper && d.d <= 0) continue;
      if (dMin != null && d.p < dMin) continue;
      if (dMax != null && d.p > dMax) continue;
      if (lMin != null && d.d < lMin) continue;
      if (lMax != null && d.d > lMax) continue;
    }
    out.push(it);
  }
  const S = F.sort;
  const byDiff = (key, dir) => (a, b) => {
    const x = diffOf(a), y = diffOf(b);
    if (!x && !y) return a.id - b.id; if (!x) return 1; if (!y) return -1;
    return dir * (x[key] - y[key]);
  };
  const byPrice = (get, dir) => (a, b) => {
    const x = get(a), y = get(b);
    if (x == null && y == null) return a.id - b.id; if (x == null) return 1; if (y == null) return -1;
    return dir * (x - y);
  };
  const cmp = {
    diffPctDesc: byDiff('p', -1), diffDesc: byDiff('d', -1), diffPctAsc: byDiff('p', 1), diffAsc: byDiff('d', 1),
    priceAsc: byPrice(i => i.price, 1), priceDesc: byPrice(i => i.price, -1),
    emagAsc: byPrice(i => emagOf(i).price, 1), emagDesc: byPrice(i => emagOf(i).price, -1),
    nameAsc: (a, b) => a.name.localeCompare(b.name, 'ro'),
  }[S];
  if (cmp) out.sort(cmp);
  return out;
}

// ---------------------------------------------------------------- catalog rendering
let RESULTS = [];
// Virtual scroll: 34,083 cards will not fit in the DOM, so only the rows in view (plus a couple
// above and below) are rendered. Spacers stand in for the rest, so the scrollbar stays honest.
const OVERSCAN = 2;
let cols = 1, cardH = 0, gap = 16, firstRow = -1, lastRow = -1;
const IC = {
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.3C1.1 8.3 3.3 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.7 0 5.9 3.8 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>',
  cmp: '<svg viewBox="0 0 24 24"><path d="M4 6h7v14H4zM13 4h7v16h-7z"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>',
};
const inAnyList = id => wishlists.lists.some(l => l.items.includes(id));
function stickerHTML(it) {
  const d = diffOf(it);
  if (!d) return '';
  if (Math.abs(d.p) < 0.5) return `<span class="sticker even">Same as eMag</span>`;
  return d.d > 0
    ? `<span class="sticker" title="Your list is ${lei(d.d)} cheaper than eMag">${pct(d.p)}<small>save ${lei(d.d)}</small></span>`
    : `<span class="sticker lose" title="eMag is ${lei(-d.d)} cheaper than your list">${pct(d.p)}<small>eMag cheaper</small></span>`;
}
function picHTML(it, cls = '') {
  const e = emagOf(it), busy = inflight.has(it.id) || queue.includes(it);
  return e.img
    ? `<img src="${esc(e.img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',innerHTML:'<span>${iconFor(it)}</span>'}))">`
    : `<div class="ph ${busy ? 'loading' : ''} ${cls}"><span>${iconFor(it)}</span></div>`;
}
function theirsHTML(it) {
  const e = emagOf(it), c = e.c;
  if (e.price != null) return `<div class="theirs"><span class="lbl">eMag${e.manual ? ' (manual)' : ''}</span>${lei(e.price)}${c?.old ? `<span class="old">${lei(c.old)}</span>` : ''}</div>`;
  if (inflight.has(it.id)) return `<div class="theirs na">Checking eMag…</div>`;
  if (c?.err) return `<div class="theirs na" title="${esc(c.err)}">eMag: not found</div>`;
  return `<div class="theirs na">eMag price not loaded</div>`;
}
function cardHTML(it) {
  const e = emagOf(it), c = e.c;
  const low = c?.ok && c.score != null && c.score < 0.4 && !overrides[it.id]?.url;
  const groups = GROUP_TAGS.filter(t => it.base.includes(t)).slice(0, 2).join(' · ');
  return `<article class="card${it.pending ? ' pending' : ''}" data-id="${it.id}">
    <button class="pic" type="button" data-act="open" aria-label="Details">${picHTML(it)}${stickerHTML(it)}</button>
    <div class="body">
      <div class="brandline"><span>${esc(it.brand || '—')}</span><span>${esc(groups)}</span></div>
      <h3 class="name" data-act="open" title="${esc(it.name)}">${esc(it.name || (it.pending ? '' : '(no name in source file)'))}</h3>
      <div class="match ${low ? 'low' : ''}"${c?.ok && c.title ? ` title="${esc(c.title)}"` : ''}>${c?.ok && c.title ? (low ? 'Weak match: ' : 'eMag: ') + esc(c.title) : ''}</div>
      <div class="prices"><div><span class="lbl">My list</span><span class="mine">${lei(it.price)}</span></div>${theirsHTML(it)}</div>
    </div>
    <div class="actions">
      <button class="act heart ${inAnyList(it.id) ? 'on' : ''}" type="button" data-act="wish" aria-label="Add to wishlist" title="Wishlist">${IC.heart}</button>
      <button class="act ${compare.includes(it.id) ? 'on' : ''}" type="button" data-act="cmp" aria-label="Add to compare" title="Compare">${IC.cmp}</button>
      <button class="act" type="button" data-act="refresh" aria-label="Load eMag data" title="Load eMag data">${IC.refresh}</button>
      <a class="emaglink" href="${esc(emagLink(it))}" target="_blank" rel="noopener noreferrer">Open in eMag ${IC.ext}</a>
    </div>
  </article>`;
}
function renderCatalog(resetScroll = true) {
  // render what is here and fill in behind: a filter over a half-downloaded list is honest about
  // being partial for a moment, which beats a blank screen
  if (wholeListNeeded() && !haveAll() && !loadingAll) loadEverything().then(() => renderCatalog(false));
  RESULTS = filtered();
  $('#grid').innerHTML = ''; firstRow = lastRow = -1;
  if (resetScroll && window.scrollY > 300) window.scrollTo({ top: 0 });
  renderWindow(true);
  $('#empty').hidden = RESULTS.length > 0;
  updateCountNow();
  const active = F.inc.length + F.exc.length + ['brand', 'pMin', 'pMax', 'dMin', 'dMax', 'lMin', 'lMax', 'inList'].filter(k => F[k]).length + (F.hasEmag ? 1 : 0) + (F.cheaper ? 1 : 0);
  $('#activeCount').textContent = active || '';
  renderTagChips();
}
function updateCountNow() {
  const withE = RESULTS.reduce((n, it) => n + (emagOf(it).price != null ? 1 : 0), 0);
  $('#count').innerHTML = `<strong>${RESULTS.length.toLocaleString('ro-RO')}</strong> products · ${withE.toLocaleString('ro-RO')} with an eMag price`;
}
const updateCount = debounce(updateCountNow, 700);
function measureGrid() {
  const g = $('#grid'), cs = getComputedStyle(g);
  cols = Math.max(1, cs.gridTemplateColumns.split(' ').filter(Boolean).length);
  gap = parseFloat(cs.rowGap) || 0;
  const probe = g.querySelector('.card');
  cardH = probe ? probe.getBoundingClientRect().height : 0;
}
function renderWindow(force = false) {
  const g = $('#grid');
  if (!RESULTS.length) { g.innerHTML = ''; firstRow = lastRow = -1; return; }
  if ($('#view-catalog').hidden) return;
  if (!cardH) {
    g.innerHTML = RESULTS.slice(0, 24).map(cardHTML).join('');
    measureGrid(); firstRow = lastRow = -1;
    if (!cardH) return;   // laid out at zero height; try again on the next scroll or resize
  }
  const rowH = cardH + gap, rows = Math.ceil(RESULTS.length / cols);
  const viewTop = window.scrollY - (g.getBoundingClientRect().top + window.scrollY);
  const first = Math.max(0, Math.floor(viewTop / rowH) - OVERSCAN);
  const last = Math.min(rows - 1, Math.ceil((viewTop + window.innerHeight) / rowH) + OVERSCAN);
  if (!force && first === firstRow && last === lastRow) return;
  firstRow = first; lastRow = last;
  const below = rows - 1 - last, out = [];
  if (first > 0) out.push('<div class="vspace" style="height:' + (first * rowH - gap) + 'px"></div>');
  out.push(RESULTS.slice(first * cols, (last + 1) * cols).map(cardHTML).join(''));
  if (below > 0) out.push('<div class="vspace" style="height:' + (below * rowH - gap) + 'px"></div>');
  g.innerHTML = out.join('');
  ensureRows(first * cols, (last + 1) * cols);
  prefetchAhead(first, last);
  syncWindowQueue();
}
// On demand means on screen: the rows the virtual scroller just drew are the only ones worth a
// request. Rows that scrolled away and have not started yet leave the queue again, so a fast scroll
// through 34,083 products spends its requests on where you stopped, not on everything you passed.
function syncWindowQueue() {
  if (batch || !settings.autoFetch || paused || firstRow < 0) return;
  const want = RESULTS.slice(firstRow * cols, (lastRow + 1) * cols).filter(it => !it.pending && !fresh(it) && !inflight.has(it.id));
  const keep = new Set(want.map(it => it.id));
  for (let i = queue.length - 1; i >= 0; i--) if (!keep.has(queue[i].id) && !pinned.has(queue[i].id)) queue.splice(i, 1);
  for (const it of want) enqueue(it);
}
function refreshCard(it) {
  const el = document.querySelector(`.card[data-id="${it.id}"]`);
  if (!el) return;
  const tmp = document.createElement('div'); tmp.innerHTML = cardHTML(it);
  const nu = tmp.firstElementChild; el.replaceWith(nu);
}
let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => { scrollTick = false; renderWindow(); });
}, { passive: true });
window.addEventListener('resize', () => { cardH = 0; renderWindow(true); });

// tag chips
let TAG_COUNTS = new Map(), TAG_SEED = [];
// The counts for the list tags are tallied when the data is split, so the sidebar is right about
// all 34,083 products on the first screen. Your own tags and the eMag categories live in small
// local stores, and those are counted here.
function countTags() {
  TAG_COUNTS = new Map(TAG_SEED);
  const bump = t => TAG_COUNTS.set(t, (TAG_COUNTS.get(t) || 0) + 1);
  for (const list of Object.values(userTags)) for (const t of new Set(list)) bump(t);
  for (const rec of cache.values()) if (rec.cats) for (const t of new Set(rec.cats)) bump('emag:' + t);
}
const debCount = debounce(() => { countTags(); renderTagChips(); }, 1500);
function chip(t) {
  const st = F.inc.includes(t) ? 'inc' : F.exc.includes(t) ? 'exc' : '';
  const kind = t.startsWith('emag:') ? 'emag' : BASE_TAGS.includes(t) ? '' : 'user';
  return `<button type="button" class="chip ${st} ${kind}" data-tag="${esc(t)}" aria-pressed="${st ? 'true' : 'false'}">${esc(t)} <small>${(TAG_COUNTS.get(t) || 0).toLocaleString('ro-RO')}</small></button>`;
}
function renderTagChips() {
  const top = [...new Set([...GROUP_TAGS, ...F.inc, ...F.exc])];
  $('#tagChips').innerHTML = top.map(chip).join('');
  if ($('.moretags').open) renderAllTags();
}
function renderAllTags() {
  const q = norm($('#tagSearch').value);
  const all = [...TAG_COUNTS.keys()].filter(t => !q || norm(t).includes(q)).sort((a, b) => TAG_COUNTS.get(b) - TAG_COUNTS.get(a)).slice(0, 300);
  $('#allTagChips').innerHTML = all.map(chip).join('') || '<p class="note">No tag matches.</p>';
}
function cycleTag(t) {
  if (F.inc.includes(t)) { F.inc = F.inc.filter(x => x !== t); F.exc.push(t); }
  else if (F.exc.includes(t)) F.exc = F.exc.filter(x => x !== t);
  else F.inc.push(t);
  saveF(); renderCatalog();
}

// ---------------------------------------------------------------- batch fetch
let batch = null;
async function startBatch() {
  // the button says these, meaning every product this view matches, so the view has to be whole first
  if (!haveAll()) { toast('Fetching the rest of the list first…'); await loadEverything(); RESULTS = filtered(); renderWindow(true); updateCountNow(); }
  const todo = RESULTS.filter(it => !it.pending && !fresh(it));
  if (!todo.length) return toast('Every product in this view already has fresh eMag data.');
  if (todo.length > 300 && !confirm(`This loads eMag data for ${todo.length.toLocaleString('ro-RO')} products, about ${settings.deep ? 2 : 1} requests each. It can take a long time and eMag may start blocking. Continue?`)) return;
  paused = false; failStreak = 0;
  batch = { total: todo.length, done: 0, ids: new Set(todo.map(i => i.id)) };
  todo.forEach(it => enqueue(it));
  $('#batchBar').hidden = false; batchTick();
}
function batchTick() {
  if (!batch) return;
  batch.done = [...batch.ids].filter(id => !inflight.has(id) && !queue.some(q => q.id === id)).length;
  $('#batchFill').style.width = (100 * batch.done / batch.total) + '%';
  $('#batchText').textContent = `${batch.done.toLocaleString('ro-RO')} of ${batch.total.toLocaleString('ro-RO')} checked`;
  if (batch.done >= batch.total) { batch = null; $('#batchBar').hidden = true; toast('eMag prices loaded. Re-apply sorting to rank them.'); renderCatalog(false); }
}
function stopBatch() {
  if (!batch) return;
  for (const id of batch.ids) { const it = BY_ID.get(id); dequeue(it); }
  batch = null; $('#batchBar').hidden = true; renderCatalog(false);
}

// ---------------------------------------------------------------- wishlists
function pickList(it) {
  const d = $('#pickList');
  const rows = wishlists.lists.map(l => `<label class="check"><input type="checkbox" data-list="${l.id}" ${l.items.includes(it.id) ? 'checked' : ''}> ${esc(l.name)} <span class="note">(${l.items.length})</span></label>`).join('');
  d.innerHTML = `<div class="sheet-head"><h2>Save to wishlist</h2><button class="icon" data-close type="button" aria-label="Close">×</button></div>
    <div class="sheet-body">${rows}<form class="row section" id="newListForm"><input name="n" type="text" placeholder="New wishlist name" required><button class="btn" type="submit">Create and add</button></form></div>`;
  d.onchange = e => {
    const id = e.target.dataset.list; if (!id) return;
    const l = wishlists.lists.find(x => x.id === id);
    l.items = e.target.checked ? [...new Set([...l.items, it.id])] : l.items.filter(x => x !== it.id);
    saveWL(); refreshCard(it); refreshDetail(it);
  };
  $('#newListForm', d).onsubmit = e => {
    e.preventDefault();
    const name = e.target.n.value.trim(); if (!name) return;
    wishlists.lists.push({ id: uid(), name, budget: null, items: [it.id] });
    saveWL(); refreshCard(it); refreshDetail(it); d.close(); toast(`Added to “${name}”`);
  };
  d.showModal();
}
function toggleWish(it) {
  if (wishlists.lists.length === 1) {
    const l = wishlists.lists[0];
    const has = l.items.includes(it.id);
    l.items = has ? l.items.filter(x => x !== it.id) : [...l.items, it.id];
    saveWL(); refreshCard(it); refreshDetail(it);
    toast(has ? `Removed from “${l.name}”` : `Added to “${l.name}”`);
  } else pickList(it);
}
function listTotals(l) {
  let mine = 0, theirs = 0, both = 0, missing = 0;
  for (const id of l.items) {
    const it = BY_ID.get(id); if (!it) continue;
    mine += it.price || 0;
    const e = emagOf(it).price;
    if (e != null && it.price != null) { theirs += e; both += it.price; } else missing++;
  }
  return { mine, theirs, save: theirs - both, missing };
}
function renderWishlists() {
  ensureIds(wishlists.lists.flatMap(l => l.items)).then(got => got && renderWishlists());
  const v = $('#view-wishlists');
  if (!wishlists.lists.find(l => l.id === wishlists.active)) wishlists.active = wishlists.lists[0]?.id;
  const l = wishlists.lists.find(x => x.id === wishlists.active);
  const tabs = wishlists.lists.map(x => `<button class="tab ${x.id === wishlists.active ? 'on' : ''}" data-tab="${x.id}" type="button">${esc(x.name)} <small>${x.items.length}</small></button>`).join('');
  let body = '';
  if (!l) body = `<div class="empty-box">You have no wishlists. Create one to start saving products.</div>`;
  else {
    const T = listTotals(l);
    const budget = l.budget;
    const usedPct = budget ? Math.min(100, (T.mine / budget) * 100) : 0;
    const rows = l.items.map(id => BY_ID.get(id)).filter(Boolean).map(it => {
      const d = diffOf(it), e = emagOf(it);
      return `<div class="wl-row" data-id="${it.id}">
        <div class="thumb">${e.img ? `<img src="${esc(e.img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : iconFor(it)}</div>
        <div><div class="t" data-act="open">${esc(it.name)}</div>
          <div class="row note"><a href="${esc(emagLink(it))}" target="_blank" rel="noopener noreferrer">Open in eMag</a><button class="link" data-act="cmp" type="button">${compare.includes(it.id) ? 'In compare' : 'Compare'}</button><button class="link" data-act="rm" type="button">Remove</button></div></div>
        <div class="p">${lei(it.price)}<small>eMag ${lei(e.price)}</small>${d ? `<span class="pill ${d.d >= 0 ? 'win' : 'lose'}">${pct(d.p)}</span>` : ''}</div>
      </div>`;
    }).join('');
    body = `
      <div class="wl-summary">
        <div class="stat"><span>Products</span><strong>${l.items.length}</strong></div>
        <div class="stat"><span>Total on my list</span><strong>${lei(T.mine)}</strong></div>
        <div class="stat"><span>Same items on eMag</span><strong>${T.theirs ? lei(T.theirs) : '—'}</strong></div>
        <div class="stat hl"><span>${T.save >= 0 ? 'You save vs eMag' : 'eMag is cheaper by'}</span><strong>${T.theirs ? lei(Math.abs(T.save)) : '—'}</strong></div>
      </div>
      ${T.missing ? `<p class="note">${T.missing} product${T.missing > 1 ? 's have' : ' has'} no eMag price yet, so they're left out of the eMag total. <button class="link" id="wlFetch" type="button">Load them now</button></p>` : ''}
      <div class="budget">
        <form class="row" id="budgetForm"><label for="budget">Budget</label><input id="budget" name="b" type="number" inputmode="decimal" value="${budget ?? ''}" placeholder="e.g. 5000"><span>lei</span><button class="btn ghost" type="submit">Set budget</button></form>
        ${budget ? `<div class="meter ${T.mine > budget ? 'over' : ''}"><span style="width:${usedPct}%"></span></div>
        <p class="note">${T.mine > budget ? `Over budget by ${lei(T.mine - budget)}` : `${lei(budget - T.mine)} left of ${lei(budget)}`}</p>` : ''}
      </div>
      <div class="wl-rows">${rows || '<div class="empty-box">This wishlist is empty. Tap the heart on any product to add it.</div>'}</div>
      <div class="wl-tools">
        <button class="btn ghost" id="wlShow" type="button">Show in catalog</button>
        <button class="btn ghost" id="wlCmp" type="button">Compare first 4</button>
        <button class="btn ghost" id="wlCsv" type="button">Download CSV</button>
        <button class="btn ghost" id="wlRename" type="button">Rename</button>
        <button class="btn danger" id="wlDel" type="button">Delete wishlist</button>
      </div>`;
  }
  v.innerHTML = `<div class="page-head"><h1>Wishlists</h1><form class="row" id="newWl"><input name="n" type="text" placeholder="New wishlist name" required><button class="btn" type="submit">Create wishlist</button></form></div>
    <div class="tabs">${tabs}</div>${body}`;
  $('#newWl', v).onsubmit = e => { e.preventDefault(); const n = e.target.n.value.trim(); if (!n) return; const nl = { id: uid(), name: n, budget: null, items: [] }; wishlists.lists.push(nl); wishlists.active = nl.id; saveWL(); renderWishlists(); };
  $$('[data-tab]', v).forEach(b => b.onclick = () => { wishlists.active = b.dataset.tab; saveWL(); renderWishlists(); });
  if (!l) return;
  $('#budgetForm', v).onsubmit = e => { e.preventDefault(); l.budget = num(e.target.b.value); saveWL(); renderWishlists(); };
  $('#wlShow', v).onclick = () => { Object.assign(F, DEFAULT_FILTERS, { inc: [], exc: [], inList: l.id }); saveF(); syncFilterUI(); location.hash = '#/catalog'; };
  $('#wlCmp', v).onclick = () => { compare = l.items.slice(0, 4); saveCmp(); location.hash = '#/compare'; };
  $('#wlCsv', v).onclick = () => downloadCSV(l.items.map(id => BY_ID.get(id)).filter(Boolean), `wishlist-${l.name}`);
  $('#wlRename', v).onclick = () => { const n = prompt('Wishlist name', l.name); if (n?.trim()) { l.name = n.trim(); saveWL(); renderWishlists(); } };
  $('#wlDel', v).onclick = () => { if (confirm(`Delete “${l.name}” and its ${l.items.length} saved products?`)) { wishlists.lists = wishlists.lists.filter(x => x !== l); wishlists.active = wishlists.lists[0]?.id; saveWL(); renderWishlists(); } };
  const wf = $('#wlFetch', v); if (wf) wf.onclick = () => { paused = false; l.items.map(id => BY_ID.get(id)).filter(it => it && emagOf(it).price == null).forEach(it => enqueue(it)); toast('Loading eMag prices…'); waitAndRender(renderWishlists); };
  v.onclick = e => {
    const row = e.target.closest('.wl-row'); if (!row) return;
    const it = BY_ID.get(+row.dataset.id), act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'rm') { l.items = l.items.filter(x => x !== it.id); saveWL(); renderWishlists(); }
    if (act === 'open') openDetail(it);
    if (act === 'cmp') { toggleCompare(it); renderWishlists(); }
  };
}
function waitAndRender(fn) {
  const t = setInterval(() => { if (!queue.length && !inflight.size) { clearInterval(t); fn(); } }, 800);
}

// ---------------------------------------------------------------- compare
function toggleCompare(it) {
  if (compare.includes(it.id)) compare = compare.filter(x => x !== it.id);
  else { if (compare.length >= 4) return toast('Compare holds 4 products. Remove one first.'); compare.push(it.id); }
  saveCmp(); refreshCard(it); refreshDetail(it);
}
function renderDock() {
  const d = $('#compareDock');
  d.hidden = !compare.length || location.hash.startsWith('#/compare');
  $('#dockN').textContent = compare.length ? `(${compare.length})` : '';
  $('#dockThumbs').innerHTML = compare.map(id => BY_ID.get(id)).filter(Boolean).map(it => `<span>${emagOf(it).img ? `<img src="${esc(emagOf(it).img)}" alt="" referrerpolicy="no-referrer">` : iconFor(it)}</span>`).join('');
}
function nameSpecs(it) {
  const parts = it.name.split(/,\s*/).slice(1);
  const out = {};
  const pick = (k, rx) => { const m = it.name.match(rx); if (m) out[k] = m[0]; };
  pick('Power', /\b\d{2,5}\s?W\b/i);
  pick('Capacity', /\b\d+(?:[.,]\d+)?\s?(?:l|L|litri|ml)\b/);
  pick('Storage', /\b\d+\s?(?:GB|TB)\b(?!\s*RAM)/i);
  pick('RAM', /\b\d+\s?GB\s?RAM\b/i);
  pick('Screen', /\b\d{1,2}(?:[.,]\d)?\s?(?:"|inch|”)/i);
  pick('Battery', /\b\d{3,5}\s?mAh\b/i);
  pick('Speed', /\b\d{3,5}\s?(?:rpm|RPM)\b/);
  pick('Pressure', /\b\d{1,3}(?:[.,]\d)?\s?(?:bar|bari|Pa)\b/i);
  return { out, parts };
}
function renderCompare() {
  ensureIds(compare).then(got => got && renderCompare());
  const v = $('#view-compare');
  const items = compare.map(id => BY_ID.get(id)).filter(Boolean);
  if (!items.length) {
    v.innerHTML = `<div class="page-head"><h1>Compare</h1></div><div class="empty-box">Add up to 4 products with the compare button on any card, then come back here.<p><a class="btn" href="#/catalog">Go to catalog</a></p></div>`;
    return;
  }
  const missing = items.filter(it => !cache.get(it.id)?.deep && !overrides[it.id]?.price);
  const best = (vals, mode) => { const xs = vals.filter(x => x != null); if (xs.length < 2) return -1; const b = mode === 'min' ? Math.min(...xs) : Math.max(...xs); return xs.filter(x => x === b).length > 1 ? -1 : vals.indexOf(b); };
  const rows = [];
  const add = (label, cells, bi = -1, cls = '') => rows.push(`<tr class="${cls}"><th scope="row">${esc(label)}</th>${cells.map((c, i) => `<td class="${i === bi ? 'best' : ''}">${c}</td>`).join('')}</tr>`);
  const lp = items.map(i => i.price), ep = items.map(i => emagOf(i).price), ds = items.map(diffOf);
  add('My list price', lp.map(x => `<span class="num">${lei(x)}</span>`), best(lp, 'min'));
  add('eMag price', ep.map(x => `<span class="num">${lei(x)}</span>`), best(ep, 'min'));
  add('Saving vs eMag', ds.map(d => d ? `<span class="pill ${d.d >= 0 ? 'win' : 'lose'}">${pct(d.p)} · ${lei(d.d)}</span>` : '—'), best(ds.map(d => d?.d ?? null), 'max'));
  add('Brand', items.map(i => esc(i.brand || '—')));
  add('eMag category', items.map(i => esc((cache.get(i.id)?.cats || []).join(' › ') || '—')));
  add('Tags', items.map(i => [...tagsOf(i)].filter(t => !t.startsWith('emag:')).map(t => `<span class="chip">${esc(t)}</span>`).join(' ')));
  const ns = items.map(nameSpecs);
  for (const k of ['Power', 'Capacity', 'Storage', 'RAM', 'Screen', 'Battery', 'Speed', 'Pressure']) if (ns.some(n => n.out[k])) add(k, ns.map(n => esc(n.out[k] || '—')));
  // eMag properties union
  const maps = items.map(i => new Map((cache.get(i.id)?.props || [])));
  const keys = []; maps.forEach(m => m.forEach((_, k) => { if (!keys.includes(k)) keys.push(k); }));
  for (const k of keys.slice(0, 50)) {
    const vals = maps.map(m => m.get(k) ?? '—');
    const same = vals.every(x => x === vals[0]);
    add(k, vals.map(esc), -1, same ? 'diffrow same' : 'diffrow');
  }
  add('Name details', ns.map(n => `<ul class="note">${n.parts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>`));
  v.innerHTML = `<div class="page-head"><h1>Compare</h1>
      ${missing.length ? `<button class="btn sticker" id="cmpFetch" type="button">Load eMag specs for ${missing.length}</button>` : ''}
      <button class="btn ghost" id="cmpClear" type="button">Clear compare</button></div>
    <div class="cmp-wrap"><table class="cmp">
      <thead><tr><th scope="col"><span class="sr-only">Field</span></th>${items.map(it => `<td>
        <div class="cpic">${emagOf(it).img ? `<img src="${esc(emagOf(it).img)}" alt="" referrerpolicy="no-referrer">` : iconFor(it)}</div>
        <p class="cname">${esc(it.name)}</p>
        <div class="row"><a class="emaglink" href="${esc(emagLink(it))}" target="_blank" rel="noopener noreferrer">Open in eMag ${IC.ext}</a>
        <button class="link" data-rm="${it.id}" type="button">Remove</button></div></td>`).join('')}</tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>
    <p class="note">Rows from eMag appear after the specs load. Lowest price and biggest saving are marked best.</p>`;
  $$('[data-rm]', v).forEach(b => b.onclick = () => { compare = compare.filter(x => x !== +b.dataset.rm); saveCmp(); renderCompare(); });
  $('#cmpClear', v).onclick = () => { compare = []; saveCmp(); renderCompare(); };
  const cf = $('#cmpFetch', v);
  if (cf) cf.onclick = async () => {
    cf.disabled = true; cf.textContent = 'Loading…';
    await Promise.all(missing.map(it => fetchEmag(it, { deep: true })));
    renderCompare();
  };
}

// ---------------------------------------------------------------- detail sheet
let detailItem = null;
function openDetail(it) { detailItem = it; renderDetail(); const d = $('#detail'); if (!d.open) d.showModal(); }
function refreshDetail(it) { if (detailItem?.id === it.id && $('#detail').open) renderDetail(); }
function renderDetail() {
  const it = detailItem, d = $('#detail'), e = emagOf(it), c = e.c, df = diffOf(it), o = overrides[it.id] || {};
  const tags = [...tagsOf(it)];
  const ut = userTags[it.id] || [];
  d.innerHTML = `<div class="sheet-head"><h2>${esc(it.name || '(no name in source file)')}</h2><button class="icon" data-close type="button" aria-label="Close">×</button></div>
  <div class="sheet-body">
    <div class="dgrid">
      <div><div class="dpic">${picHTML(it)}${stickerHTML(it)}</div>
        <div class="row section">
          <a class="btn sticker" href="${esc(emagLink(it))}" target="_blank" rel="noopener noreferrer">Open in eMag</a>
          <button class="btn ghost" data-d="wish" type="button">${inAnyList(it.id) ? 'Saved ♥' : 'Save to wishlist'}</button>
          <button class="btn ghost" data-d="cmp" type="button">${compare.includes(it.id) ? 'In compare' : 'Compare'}</button>
        </div></div>
      <div>
        <dl class="kv">
          <dt>My list</dt><dd><span class="bigprice">${lei(it.price)}</span></dd>
          <dt>eMag</dt><dd><strong>${lei(e.price)}</strong>${c?.old ? ` <s class="note">${lei(c.old)}</s>` : ''}${e.manual ? ' <span class="note">(entered manually)</span>' : ''}</dd>
          <dt>Difference</dt><dd>${df ? `<span class="pill ${df.d >= 0 ? 'win' : 'lose'}">${df.d >= 0 ? 'You save' : 'eMag cheaper by'} ${lei(Math.abs(df.d))} (${Math.abs(df.p).toFixed(1)}%)</span>` : '—'}</dd>
          <dt>Brand</dt><dd>${esc(it.brand || '—')}</dd>
          <dt>List no.</dt><dd>#${it.id}</dd>
          ${c?.title ? `<dt>eMag match</dt><dd>${esc(c.title)} <span class="note">${c.score != null && !o.url ? `(${Math.round(c.score * 100)}% name match)` : ''}</span></dd>` : ''}
          ${c?.cats?.length ? `<dt>eMag category</dt><dd>${esc(c.cats.join(' › '))}</dd>` : ''}
          ${c ? `<dt>Checked</dt><dd>${new Date(c.t).toLocaleString('ro-RO')}${c.err ? ` · <span class="err">${esc(c.err)}</span>` : ''}</dd>` : ''}
        </dl>
        <div class="row section"><button class="btn" data-d="fetch" type="button" ${inflight.has(it.id) ? 'disabled' : ''}>${inflight.has(it.id) ? 'Checking eMag…' : c ? 'Refresh eMag data' : 'Load eMag data'}</button></div>
      </div>
    </div>
    <div class="section"><h3>Tags</h3>
      <div class="chips">${tags.map(t => `<span class="chip ${t.startsWith('emag:') ? 'emag' : ut.includes(t) ? 'user' : ''}">${esc(t)}${ut.includes(t) ? ` <button class="link" data-untag="${esc(t)}" type="button" aria-label="Remove tag ${esc(t)}">×</button>` : ''}</span>`).join('')}</div>
      <form class="row section" id="tagForm"><input name="t" type="text" placeholder="Add your own tag, e.g. for-dad" maxlength="40"><button class="btn ghost" type="submit">Add tag</button></form>
    </div>
    <div class="section"><h3>Fix the eMag match</h3>
      <p class="note">Wrong product picked, or eMag blocked? Paste the exact eMag product link, or type the price you see on eMag.</p>
      <form class="row" id="ovForm"><input name="u" type="url" placeholder="https://www.emag.ro/…/pd/…" value="${esc(o.url || '')}"><input name="p" type="number" inputmode="decimal" step="0.01" placeholder="eMag price" value="${o.price ?? ''}" style="max-width:140px"><button class="btn ghost" type="submit">Save</button></form>
      ${o.url || o.price != null ? '<button class="link" id="ovClear" type="button">Clear my fix</button>' : ''}
    </div>
    ${c?.props?.length ? `<div class="section"><h3>eMag specifications</h3><table class="specs">${c.props.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table></div>` : ''}
  </div>`;
  d.onclick = ev => {
    if (ev.target === d || ev.target.closest('[data-close]')) return d.close();
    const a = ev.target.closest('[data-d]')?.dataset.d;
    if (a === 'wish') toggleWish(it);
    if (a === 'cmp') toggleCompare(it);
    if (a === 'fetch') { paused = false; failStreak = 0; enqueue(it, true); renderDetail(); }
    const un = ev.target.closest('[data-untag]')?.dataset.untag;
    if (un) { userTags[it.id] = ut.filter(x => x !== un); if (!userTags[it.id].length) delete userTags[it.id]; saveUT(); it._tags = null; debCount(); renderDetail(); refreshCard(it); }
  };
  $('#tagForm', d).onsubmit = ev => {
    ev.preventDefault();
    const t = ev.target.t.value.trim().toLowerCase().replace(/\s+/g, '-'); if (!t) return;
    userTags[it.id] = [...new Set([...(userTags[it.id] || []), t])]; saveUT(); it._tags = null;
    countTags(); renderDetail(); renderTagChips(); toast(`Tagged “${t}”`);
  };
  $('#ovForm', d).onsubmit = ev => {
    ev.preventDefault();
    const u = ev.target.u.value.trim(), p = num(ev.target.p.value);
    if (u && !/^https:\/\/(www\.)?emag\.ro\//.test(u)) return toast('Use a link that starts with https://www.emag.ro/');
    if (!u && p == null) delete overrides[it.id]; else overrides[it.id] = { url: u || undefined, price: p ?? undefined };
    saveOV(); if (u) enqueue(it, true);
    renderDetail(); refreshCard(it); toast('Saved');
  };
  const oc = $('#ovClear', d); if (oc) oc.onclick = () => { delete overrides[it.id]; saveOV(); renderDetail(); refreshCard(it); };
}

// ---------------------------------------------------------------- settings
function srcNote() {
  const s = settings.source || 'auto';
  if (s === 'bridge') return bridgeVia ? 'The ' + bridgeVia + ' is answering.' : 'Not installed on this page yet.';
  if (s === 'local') return localOK === false ? 'Not running.' : localOK ? 'Answering.' : 'Start it, then test.';
  if (s === 'proxies') return '';
  if (bridgeVia) return 'Using the ' + bridgeVia + '.';
  return 'No userscript or extension here, so: this computer, then a public proxy.';
}
function renderSettings() {
  const v = $('#view-settings');
  const nOk = [...cache.values()].filter(c => c.ok).length;
  v.innerHTML = `<div class="page-head"><h1>Settings</h1></div><div class="settings">
    <div class="panel"><h2>Where eMag prices come from</h2>
      <p>This site is a static page with no server of its own, and eMag does not let a page read its replies. The request has to be made by something on this device: a userscript or the small extension (nothing to run), or the reader script on this computer.</p>
      <div class="row"><label for="sSrc">Read eMag through</label><select id="sSrc" style="max-width:250px">
        <option value="auto">Whatever is available</option>
        <option value="bridge">The userscript or extension</option>
        <option value="local">This computer</option>
        <option value="proxies">A public CORS proxy</option>
      </select><span class="note" id="sSrcNow">${srcNote()}</span></div>

      <details class="section"${settings.source === 'local' || settings.source === 'proxies' ? '' : ' open'}><summary>Userscript or extension — nothing to run</summary>
        <p>Both do the same thing: the page asks them for an eMag address, they fetch it in this browser and hand back the page. They only ever touch <code>emag.ro</code>, and only on this site.</p>
        <p><strong>Userscript</strong> — install Tampermonkey or Violentmonkey, then open <a href="tools/emaglist.user.js">emaglist.user.js</a> and confirm. Reload this page afterwards.</p>
        <p><strong>Extension</strong> — download <code>tools/extension/</code> from the repository, then in Chrome open <code>chrome://extensions</code>, switch on Developer mode and press “Load unpacked” on that folder.</p>
      </details>

      <details${settings.source === 'local' ? ' open' : ''}><summary>This computer — a reader you start yourself</summary>
        <p>Run <code>node tools/emag-proxy.js</code> in the project folder and leave it open. It fetches eMag at three requests at a time, keeps each answer for half an hour and refuses any address that is not eMag.</p>
        <p class="note">Some browsers will not let a page served over https talk to your own machine at all. If the test below fails while the reader is plainly running, that is why — use the userscript or the extension instead, which have nothing to reach.</p>
        <div class="row"><label for="sPort">Port</label><input id="sPort" type="number" min="1" max="65535" value="${settings.localPort || 8787}" style="max-width:110px"><span class="note">matches <code>PORT=</code> if you moved it</span></div>
      </details>

      <details${settings.source === 'proxies' ? ' open' : ''}><summary>Public CORS proxy — last resort</summary>
        <p>Somebody else's server fetches the page for you, which means your list goes through it and it can be blocked or switched off without warning. Every public one was failing when this was written. One per line; <code>{url}</code> becomes the encoded eMag address, <code>{raw}</code> the plain one.</p>
        <textarea id="sProx" spellcheck="false">${esc(settings.proxies.join('\n'))}</textarea>
        <div class="row"><button class="link" id="sDef" type="button">Restore defaults</button></div>
      </details>

      <div class="row section"><button class="btn" id="sTest" type="button">Test connection</button><span id="sTestOut" class="note"></span></div>
      <label class="check section"><input type="checkbox" id="sAuto" ${settings.autoFetch ? 'checked' : ''}> Load eMag data on demand, for the cards on screen</label>
      <label class="check"><input type="checkbox" id="sDeep" ${settings.deep ? 'checked' : ''}> Also read the eMag product page for category tags and specifications (2 requests per product)</label>
      <div class="row"><label for="sConc">Parallel requests</label><input id="sConc" type="number" min="1" max="6" value="${settings.concurrency}" style="max-width:90px">
        <label for="sTtl">Refresh after (hours)</label><input id="sTtl" type="number" min="1" value="${settings.ttlHours}" style="max-width:100px"></div>
    </div>
    <div class="panel"><h2>Saved eMag data</h2>
      <p>${cache.size.toLocaleString('ro-RO')} products checked, ${nOk.toLocaleString('ro-RO')} with a price. Stored in this browser only.</p>
      <div class="row"><button class="btn ghost" id="sClear" type="button">Clear saved eMag data</button><button class="btn ghost" id="sCsv" type="button">Download all products as CSV</button></div>
    </div>
    <div class="panel"><h2>Backup</h2>
      <p>Wishlists, your tags, compare picks and eMag fixes live in this browser. Download a backup to move them to another device.</p>
      <div class="row"><button class="btn ghost" id="sExp" type="button">Download backup</button><label class="btn ghost" for="sImp">Restore from backup</label><input id="sImp" type="file" accept="application/json" hidden></div>
    </div>
    <div class="panel"><h2>Appearance</h2>
      <div class="row"><label for="sTheme">Theme</label><select id="sTheme" style="max-width:200px">
        <option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
    </div>
  </div>`;
  $('#sTheme', v).value = settings.theme;
  $('#sSrc', v).value = settings.source || 'auto';
  const persist = () => {
    settings.proxies = $('#sProx', v).value.split('\n').map(s => s.trim()).filter(Boolean);
    settings.source = $('#sSrc', v).value;
    const port = Math.max(1, Math.min(65535, parseInt($('#sPort', v).value) || 8787));
    if (port !== settings.localPort) { settings.localPort = port; localOK = null; localProbe = null; }
    settings.autoFetch = $('#sAuto', v).checked; settings.deep = $('#sDeep', v).checked;
    settings.concurrency = Math.max(1, Math.min(6, parseInt($('#sConc', v).value) || 3));
    settings.ttlHours = Math.max(1, parseInt($('#sTtl', v).value) || 72);
    settings.theme = $('#sTheme', v).value; applyTheme(); paused = false; failStreak = 0; saveSettings(); syncWindowQueue();
    $('#sSrcNow', v).textContent = srcNote();
  };
  v.onchange = persist;
  $('#sDef', v).onclick = () => { $('#sProx', v).value = DEFAULT_PROXIES.join('\n'); persist(); };
  $('#sTest', v).onclick = async () => {
    persist(); const out = $('#sTestOut', v); out.textContent = 'Testing…';
    const it = ITEMS.find(i => i.price && i.name.length > 20);
    const t0 = performance.now();
    try {
      const r = parseSearch(await proxyFetch(searchURL(it)));
      const how = SOURCE_NAMES[usedSource] || usedSource;
      out.textContent = r.length
        ? `Works: ${r.length} eMag results in ${Math.round(performance.now() - t0)} ms, through ${how}.`
        : `The request got through ${how}, but the page had no products on it. eMag may be serving a check page.`;
      $('#sSrcNow', v).textContent = srcNote();
    }
    catch (e) { out.textContent = 'Failed: ' + e.message; }
  };
  $('#sClear', v).onclick = () => { if (confirm('Delete all saved eMag prices, pictures and specs?')) { clearCache(); countTags(); renderSettings(); toast('Saved eMag data cleared'); } };
  $('#sCsv', v).onclick = () => downloadCSV(ITEMS, 'bf-list-all');
  $('#sExp', v).onclick = () => {
    const blob = new Blob([JSON.stringify({ app: 'emaglist', v: 1, wishlists, userTags, overrides, compare, settings }, null, 1)], { type: 'application/json' });
    dl(blob, 'emaglist-backup.json');
  };
  $('#sImp', v).onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); if (j.app !== 'emaglist') throw new Error('Not an EmagList backup');
      if (j.wishlists?.lists) { const ids = new Set(wishlists.lists.map(l => l.id)); j.wishlists.lists.forEach(l => ids.has(l.id) ? Object.assign(wishlists.lists.find(x => x.id === l.id), l) : wishlists.lists.push(l)); saveWL(); }
      Object.assign(userTags, j.userTags || {}); saveUT(); Object.assign(overrides, j.overrides || {}); saveOV();
      if (Array.isArray(j.compare)) { compare = j.compare.slice(0, 4); saveCmp(); }
      ITEMS.forEach(i => (i._tags = null)); countTags(); toast('Backup restored');
    } catch (err) { toast('Could not restore: ' + err.message); }
  };
}
function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

// ---------------------------------------------------------------- CSV
function dl(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
function downloadCSV(list, name) {
  const q = v => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['nr', 'name', 'brand', 'list_price', 'emag_price', 'diff_lei', 'diff_pct', 'tags', 'emag_url'];
  const lines = [head.join(',')];
  for (const it of list) {
    const e = emagOf(it), d = diffOf(it);
    lines.push([it.id, it.name, it.brand, it.price, e.price, d ? d.d.toFixed(2) : '', d ? d.p.toFixed(1) : '', [...tagsOf(it)].join('|'), emagLink(it)].map(q).join(','));
  }
  dl(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }), name.replace(/[^\w-]+/g, '_') + '.csv');
}

// ---------------------------------------------------------------- routing & wiring
function route() {
  const v = (location.hash.match(/^#\/(\w+)/) || [, 'catalog'])[1];
  const view = ['catalog', 'wishlists', 'compare', 'settings'].includes(v) ? v : 'catalog';
  $$('.view').forEach(s => (s.hidden = s.id !== 'view-' + view));
  $$('.views a').forEach(a => a.classList.toggle('on', a.dataset.view === view));
  if (view === 'catalog') renderCatalog(false);
  if (view === 'wishlists') renderWishlists();
  if (view === 'compare') renderCompare();
  if (view === 'settings') renderSettings();
  renderDock();
}
function updateBadges() {
  const n = new Set(wishlists.lists.flatMap(l => l.items)).size;
  $('#wlCount').textContent = n || '';
  $('#cmpCount').textContent = compare.length || '';
  const sel = $('#inList'), cur = F.inList;
  sel.innerHTML = '<option value="">Everything</option>' + wishlists.lists.map(l => `<option value="${l.id}">${esc(l.name)} (${l.items.length})</option>`).join('');
  sel.value = cur;
}
function syncFilterUI() {
  $('#q').value = F.q; $('#sort').value = F.sort; $('#brand').value = F.brand;
  ['pMin', 'pMax', 'dMin', 'dMax', 'lMin', 'lMax'].forEach(k => ($('#' + k).value = F[k]));
  $('#hasEmag').checked = F.hasEmag; $('#cheaper').checked = F.cheaper;
  $$('input[name="tagMode"]').forEach(r => (r.checked = r.value === F.tagMode));
  updateBadges(); $('#inList').value = F.inList;
}
function wire() {
  const rerender = debounce(() => { saveF(); renderCatalog(); }, 200);
  $('#q').addEventListener('input', e => { F.q = e.target.value; if (!location.hash.startsWith('#/catalog') && location.hash) location.hash = '#/catalog'; rerender(); });
  $('#sort').onchange = e => { F.sort = e.target.value; saveF(); renderCatalog(); };
  $('#brand').addEventListener('input', e => { F.brand = e.target.value; rerender(); });
  ['pMin', 'pMax', 'dMin', 'dMax', 'lMin', 'lMax'].forEach(k => $('#' + k).addEventListener('input', e => { F[k] = e.target.value; rerender(); }));
  $('#hasEmag').onchange = e => { F.hasEmag = e.target.checked; rerender(); };
  $('#cheaper').onchange = e => { F.cheaper = e.target.checked; rerender(); };
  $('#inList').onchange = e => { F.inList = e.target.value; rerender(); };
  $$('input[name="tagMode"]').forEach(r => (r.onchange = () => { F.tagMode = r.value; rerender(); }));
  $('#filters').addEventListener('click', e => { const c = e.target.closest('.chip[data-tag]'); if (c) cycleTag(c.dataset.tag); });
  $('.moretags').addEventListener('toggle', () => { if ($('.moretags').open) renderAllTags(); });
  $('#tagSearch').addEventListener('input', debounce(renderAllTags, 150));
  $('#resetFilters').onclick = () => { Object.assign(F, DEFAULT_FILTERS, { inc: [], exc: [] }); saveF(); syncFilterUI(); renderCatalog(); };
  $('#openFilters').onclick = () => $('#filters').classList.add('open');
  $('#closeFilters').onclick = () => $('#filters').classList.remove('open');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#filters').classList.remove('open'); });
  $('#batchFetch').onclick = startBatch;
  $('#batchStop').onclick = stopBatch;
  $('#dockClear').onclick = () => { const old = compare; compare = []; saveCmp(); old.forEach(id => refreshCard(BY_ID.get(id))); };
  $('#grid').addEventListener('click', e => {
    const card = e.target.closest('.card'); if (!card) return;
    const it = BY_ID.get(+card.dataset.id), act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') openDetail(it);
    if (act === 'wish') toggleWish(it);
    if (act === 'cmp') toggleCompare(it);
    if (act === 'refresh') { paused = false; failStreak = 0; enqueue(it, true); }
  });
  for (const id of ['#detail', '#pickList']) $(id).addEventListener('click', e => { if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.close(); });
  $('#detail').addEventListener('close', () => { detailItem = null; if (!$('#view-wishlists').hidden) renderWishlists(); if (!$('#view-compare').hidden) renderCompare(); });
  window.addEventListener('hashchange', route);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  applyTheme();
  try {
    await Promise.all([loadIndex(), openDB().then(loadCache)]);
    await loadChunk(0);                       // the first screen, so it never opens on skeletons
    countTags();
    wire(); syncFilterUI(); route();
    // the 1,223-entry brand datalist is not worth a frame of the first screen
    const idle = window.requestIdleCallback || (fn => setTimeout(fn, 50));
    idle(() => { $('#brandList').innerHTML = BRANDS.map(b => `<option value="${esc(b)}">`).join(''); });
  } catch (e) {
    $('#loading').innerHTML = `<p>Could not load the product list: ${esc(e.message)}</p>`;
    return;
  }
  $('#loading').remove();
})();
