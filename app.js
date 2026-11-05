/* BF list vs eMag.

   One hardcoded product list, shown a page at a time. A card asks eMag for its own price when it
   comes near the viewport, and never before: search by title, keep the closest-named result, show
   that price and picture.

   Six views, all off the same data and the same little lookup queue: the catalog, the best savings
   found so far, the ones you liked, a budget you can spend down, up to four side by side, and the
   settings.

   Three ways to reach eMag, decided once at startup.
     - The self-hosted copy answers at /api/*: it reads eMag itself, remembers every answer in its
       own database, and never asks twice. That is also where the budget, the accounts and the
       price watcher live.
     - An older self-hosted copy only has the raw reader at /emag?u=..., so the page parses the
       search results itself.
     - On github.io there is neither, so the request goes straight to emag.ro and only gets
       through with tools/emaglist.user.js installed -- the browser will otherwise fetch eMag's
       reply and then refuse to hand it over. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = MATCH.norm;   /* match.js, loaded just before this file */
const nf = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ro = n => Number(n).toLocaleString('ro-RO');
const lei = v => v == null || isNaN(v) ? '—' : nf.format(v) + ' lei';
const pct = p => (p > 0 ? '−' : '+') + Math.abs(p).toFixed(0) + '%';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const nice = n => !n || n === '0' ? '(no name in the source list)' : n;
const ago = t => {
  if (!t) return 'never';
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 172800) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
};

/* ---------------------------------------------------------------- settings */
const SET = Object.assign({
  theme: 'system',      // system | light | dark
  autoLoad: true,       // ask eMag as cards reach the screen
  parallel: 3,          // lookups in flight at once
  keepHours: 24,        // how long an answer is reused
  budget: null,         // the soft budget on the liked page
  tagsOpen: false,      // the sections rail
  moreOpen: false,      // the second row of filters
  dense: false,         // tighter cards
}, load('bf.set', {}));
const saveSet = () => save('bf.set', SET);
function applyTheme() {
  if (SET.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = SET.theme;
  document.documentElement.classList.toggle('dense', !!SET.dense);
}

/* ---------------------------------------------------------------- state */
const PER = 60;
let ITEMS = [], RESULTS = [], page = 0, TAGS = [], VIEW = 'catalog';
const byId = new Map();
const emag = new Map();   // id -> {busy:true} | {t,price,img,url,title,old,score,low,hist} | {t,err}
const picks = new Map();  // id -> {qty,bought,target}  (only with a backend and an account)

const FRESH = {
  q: '', sort: 'order', brand: '', onlyWish: false, tags: [], match: 'any',
  min: '', max: '', minPct: 0, state: '', pickState: '',
};
const F = Object.assign({}, FRESH);
const D = { min: 0, batch: 250 };   // top deals

const wish = new Set(load('bf.wish', []));
const saveWish = () => { save('bf.wish', [...wish]); badges(); };
let cmp = load('bf.cmp', []).slice(0, 4);
const saveCmp = () => { save('bf.cmp', cmp); badges(); dock(); };

/* What eMag answered is kept, so paging back and forth does not ask twice and a reload does not
   start from nothing. Only the most recent few thousand are written back: the whole catalog would
   not fit in localStorage, and the oldest are the ones worth asking again anyway. With a backend
   in the picture this is only a local echo of its database. */
const STORE = 'bf.emag';
const keepMs = () => Math.max(1, SET.keepHours) * 36e5;
function loadStore() {
  const o = load(STORE, {});
  for (const id in o) if (o[id].t && Date.now() - o[id].t < keepMs()) emag.set(+id, o[id]);
}
const saveStore = debounce(() => {
  const rows = [...emag].filter(e => e[1].t).sort((a, b) => b[1].t - a[1].t).slice(0, 4000);
  save(STORE, Object.fromEntries(rows));
}, 1500);

/* ---------------------------------------------------------------- reaching eMag */
/* What to ask eMag about a product, and which of its answers is that product: both are match.js,
   the one file the server requires too, so a row read in this page and a row read there cannot
   disagree. The brand goes in because it is the one word in a name that cannot be wrong. */
const searchURL = (it, tier) => MATCH.searchURL(it.name, tier, it.brand);
const closest = (it, hits) => MATCH.closest(it.name, hits, { brand: it.brand });
const linkFor = it => (emag.get(it.id) || {}).url || searchURL(it);

let READER = null;   // null until probed, then true (something on this origin) or false
let BE = null;       // the full backend: null, or what /api/hello said
let ME = null;       // the account signed in on it

async function findReader() {
  try {
    const r = await fetch('api/hello', { cache: 'no-store', credentials: 'same-origin' });
    if (r.ok) {
      BE = await r.json();
      ME = BE.user || null;
      READER = true;
      return;
    }
  } catch (e) { /* no backend here; fall through to the older probe */ }
  try {
    const r = await fetch('emag/ping', { cache: 'no-store' });
    READER = r.ok && (await r.text()).trim() === 'ok';
  } catch (e) { READER = false; }
}

/* Every call to the backend goes through here. */
async function API(path, opt) {
  const o = Object.assign({ credentials: 'same-origin' }, opt || {});
  if (o.body != null && typeof o.body !== 'string') {
    o.body = JSON.stringify(o.body);
    o.headers = Object.assign({ 'Content-Type': 'application/json' }, o.headers || {});
  }
  const r = await fetch('api/' + path, o);
  let j = {};
  try { j = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) throw new Error(j.error || 'the server answered ' + r.status);
  return j;
}

async function get(url) {
  const r = await fetch(READER ? 'emag?u=' + encodeURIComponent(url) : url, { credentials: 'omit' });
  if (!r.ok) throw new Error(READER ? 'The reader answered ' + r.status : 'eMag answered ' + r.status);
  return r.text();
}

/* A few at a time. A page holds sixty cards and the observer can fire on a dozen at once, so
   without this a single scroll would open a dozen connections and eMag would start refusing. */
const waiting = [], busy = new Set();
function ask(it, force) {
  if (force) emag.delete(it.id);
  if (emag.has(it.id) || waiting.some(w => w.it === it)) return;
  waiting.push({ it, force: !!force });
  pump();
}
function pump() {
  while (busy.size < Math.max(1, SET.parallel) && waiting.length) {
    const job = waiting.shift();
    const it = job.it;
    busy.add(it.id);
    emag.set(it.id, { busy: true });
    paint(it);
    look(it, job.force).finally(() => {
      busy.delete(it.id);
      paint(it);
      saveStore();
      tally();
      progress();
      bump();
      pump();
    });
  }
}
async function look(it, force) {
  try {
    if (BE) {
      /* The server has it, or goes and gets it. Either way this page asks eMag for nothing. */
      const j = await API('emag/' + it.id + (force ? '?force=1' : ''));
      if (j.error) throw new Error(j.error);
      const e = j.emag || {};
      emag.set(it.id, {
        t: Date.now(), price: e.price, old: e.old, img: e.img, url: e.url,
        title: e.title, score: e.score, low: e.low, hist: e.hist || [], at: e.t,
      });
      return;
    }
    /* Two asks at most. The second goes out only when the first came back with nothing, or with
       nothing that looks like the thing, and carries just the brand and the model. */
    let best = null, any = 0;
    for (let tier = 0; tier < MATCH.tiers; tier++) {
      const hits = parseSearch(await get(searchURL(it, tier)));
      any += hits.length;
      const b = closest(it, hits);
      if (b && b.price != null && (!best || b.score > best.score)) best = b;
      if (best && best.score >= MATCH.THIN) break;
    }
    if (!any) throw new Error('Nothing on eMag under this name');
    if (!best) throw new Error('No price on the closest result');
    emag.set(it.id, Object.assign({ t: Date.now() }, best));
  } catch (e) {
    emag.set(it.id, { t: Date.now(), err: why(e) });
  }
}
/* "Failed to fetch" is all the browser will say when it refuses to hand over a cross-origin reply,
   and it is the one failure that installing something can fix, so name it. */
function why(e) {
  const m = String(e && e.message || e);
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(m)) {
    if (READER) return 'The reader on this server could not be reached';
    blocked();
    return 'The browser would not let this page read eMag';
  }
  return m.slice(0, 140);
}
function blocked() {
  const b = $('#blocked');
  if (!b || !b.hidden) return;
  b.innerHTML = 'Your browser will not let this page read emag.ro, so the eMag side stays empty. '
    + 'Install <a href="tools/emaglist.user.js">tools/emaglist.user.js</a> in Tampermonkey or '
    + 'Violentmonkey and reload &mdash; or open the self-hosted copy of this site, which reads eMag '
    + 'on the server and needs nothing installed.';
  b.hidden = false;
}
/* Asking for a batch on purpose: the deals, liked and budget pages all do it. */
function askMany(items, max, force) {
  const todo = items.filter(it => force || !emag.has(it.id)).slice(0, max);
  todo.forEach(it => ask(it, force));
  progress();
  return todo.length;
}
const stopAsking = () => { waiting.length = 0; progress(); };
const left = () => waiting.length + busy.size;
function progress() {
  $$('[data-prog]').forEach(el => {
    const n = left();
    el.textContent = n ? ro(n) + ' to go' : '';
    el.classList.toggle('on', !!n);
  });
  $$('[data-stop]').forEach(b => { b.hidden = !left(); });
}
/* While a batch is running, answers land every few hundred milliseconds. A plain debounce would sit
   waiting for a gap that never comes, so the open page is redrawn on a leash instead: straight away,
   then at most once every 1.2s, and once more when the traffic stops. */
let bumpAt = 0, bumpT = null;
function bump() {
  if (VIEW === 'catalog') return;
  clearTimeout(bumpT);
  bumpT = setTimeout(() => { bumpAt = Date.now(); draw[VIEW](); }, Math.max(0, 1200 - (Date.now() - bumpAt)));
}

const absUrl = u => !u ? null
  : u.indexOf('//') === 0 ? 'https:' + u
  : u.charAt(0) === '/' ? 'https://www.emag.ro' + u : u;
function priceOf(el) {
  if (!el) return null;
  const sup = el.querySelector('sup');
  if (sup) {
    const cents = sup.textContent.replace(/\D/g, '').slice(0, 2);
    const cl = el.cloneNode(true);
    $$('sup,span,s,del', cl).forEach(n => n.remove());
    const ints = cl.textContent.replace(/[^\d]/g, '');
    if (ints) return parseFloat(ints + '.' + (cents || '0'));
  }
  const m = el.textContent.replace(/\s/g, '').match(/(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/);
  return m ? parseFloat(m[1].replace(/\./g, '') + '.' + (m[2] || '0')) : null;
}
function parseSearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const c of $$('.card-item[data-url], .card-v2[data-url], [data-product-id][data-url], .card-item', doc)) {
    const a = c.querySelector('a.card-v2-title, a.js-product-url, h2 a, a[href*="/pd/"]');
    const url = absUrl(c.dataset.url || (a && a.getAttribute('href')));
    if (!url || !/emag\.ro/.test(url)) continue;
    const im = c.querySelector('img');
    const src = im && im.getAttribute('src');
    const price = priceOf(c.querySelector('.product-new-price'));
    const old = priceOf(c.querySelector('.product-old-price s, .product-old-price, .rrp-lp30d-content'));
    out.push({
      url: url.split('#')[0],
      title: String(c.dataset.name || (a && (a.textContent || a.title)) || '').trim(),
      img: absUrl(src && src.indexOf('data:') === 0 ? (im.dataset.src || im.dataset.original) : (src || (im && im.dataset.src))),
      price: price,
      old: old && price && old > price ? old : null,
    });
  }
  return out.filter(r => r.url && r.title);
}

/* On demand means on screen. A card asks for its data once it is within 400px of the viewport and
   not before -- which is also what makes paging cheap: sixty lookups a page, not 34,083. */
const watcher = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) {
    watcher.unobserve(e.target);
    const it = byId.get(+e.target.dataset.id);
    if (it && SET.autoLoad) ask(it);
  }
}, { rootMargin: '400px' });

/* ---------------------------------------------------------------- filtering */
function diffOf(it) {
  const r = emag.get(it.id);
  if (!r || r.price == null || it.price == null) return null;
  return { d: r.price - it.price, p: (r.price - it.price) / r.price * 100 };
}
const hay = it => it._hay || (it._hay = norm(it.name + ' ' + it.brand + ' ' + it.tags.join(' ')));
const ep = it => { const r = emag.get(it.id); return r && r.price != null ? r.price : null; };

function filtered(opt) {
  const o = opt || {};
  const qs = norm(F.q).split(/\s+/).filter(Boolean);
  const brand = norm(F.brand.trim());
  const min = F.min === '' ? null : +F.min;
  const max = F.max === '' ? null : +F.max;
  const out = [];
  for (const it of ITEMS) {
    if (F.onlyWish && !wish.has(it.id)) continue;
    if (brand && norm(it.brand).indexOf(brand) < 0) continue;
    if (!o.skipTags && F.tags.length) {
      const has = F.tags.filter(t => it.tags.includes(t)).length;
      if (F.match === 'all' ? has !== F.tags.length : !has) continue;
    }
    if (qs.length) { const h = hay(it); if (!qs.every(x => h.indexOf(x) >= 0)) continue; }
    if (min != null && !(it.price != null && it.price >= min)) continue;
    if (max != null && !(it.price != null && it.price <= max)) continue;

    if (F.state) {
      const r = emag.get(it.id) || null;
      const got = r && r.price != null;
      if (F.state === 'priced' && !got) continue;
      if (F.state === 'unpriced' && (got || (r && r.busy))) continue;
      if (F.state === 'nolist' && it.price != null) continue;
      if (F.state === 'cheaper' && !(got && it.price != null && it.price < r.price)) continue;
      if (F.state === 'dearer' && !(got && it.price != null && it.price > r.price)) continue;
    }
    if (F.minPct) { const d = diffOf(it); if (!d || d.p < F.minPct) continue; }
    if (F.pickState) {
      const p = picks.get(it.id);
      if (F.pickState === 'picked' && !p) continue;
      if (F.pickState === 'bought' && !(p && p.bought)) continue;
      if (F.pickState === 'unbought' && !(p && !p.bought)) continue;
    }
    out.push(it);
  }

  const num = (pick, dir) => (a, b) => {
    const x = pick(a), y = pick(b);
    if (x == null && y == null) return a.id - b.id;
    if (x == null) return 1;
    if (y == null) return -1;
    return dir * (x - y);
  };
  const by = {
    orderDesc: (a, b) => b.id - a.id,
    nameAsc: (a, b) => a.name.localeCompare(b.name, 'ro'),
    nameDesc: (a, b) => b.name.localeCompare(a.name, 'ro'),
    brandAsc: (a, b) => (a.brand || 'zzzz').localeCompare(b.brand || 'zzzz', 'ro') || a.id - b.id,
    priceAsc: num(i => i.price, 1),
    priceDesc: num(i => i.price, -1),
    emagAsc: num(ep, 1),
    emagDesc: num(ep, -1),
    saveDesc: num(i => (diffOf(i) || {}).d, -1),
    saveAsc: num(i => (diffOf(i) || {}).d, 1),
    savePctDesc: num(i => (diffOf(i) || {}).p, -1),
    freshDesc: num(i => (emag.get(i.id) || {}).t, -1),
  }[F.sort];
  if (by) out.sort(by);
  return out;
}
const anyFilter = () => !!(F.q.trim() || F.brand.trim() || F.tags.length || F.onlyWish
  || F.min !== '' || F.max !== '' || F.minPct || F.state || F.pickState);

/* ---------------------------------------------------------------- bits of markup */
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.3C1.1 8.3 3.3 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.7 0 5.9 3.8 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';
const AGAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.5 11a8.5 8.5 0 1 0-2.6 6.1M20.5 4.5V11h-6.5"/></svg>';
const SCALE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v18M7 21h10M3 8h18M6 8l-3 6h6zM18 8l-3 6h6z"/></svg>';
const CART = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.2a2 2 0 0 0 2-1.5L21 8H6"/><circle cx="10" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/></svg>';

const pic = (r, cls) => r && r.img
  ? '<img class="' + (cls || '') + '" src="' + esc(r.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
  : '<div class="ph' + (r && r.busy ? ' busy' : '') + '"></div>';
function sticker(d) {
  if (!d) return '';
  return '<span class="tag ' + (d.d > 0 ? 'win' : 'lose') + '">' + pct(d.p)
    + '<small>' + (d.d > 0 ? 'save ' : 'eMag +') + lei(Math.abs(d.d)) + '</small></span>';
}
function theirs(it) {
  const r = emag.get(it.id) || {};
  if (r.busy) return '<span class="na">Asking eMag…</span>';
  if (r.err) return '<span class="na err" title="' + esc(r.err) + '">' + esc(r.err) + '</span>';
  if (r.price != null) return '<strong>' + lei(r.price) + '</strong>' + (r.old ? ' <s>' + lei(r.old) + '</s>' : '');
  if (r.t) return '<span class="na">No price on the eMag page</span>';
  return '<span class="na">—</span>';
}
const inCmp = it => cmp.includes(it.id);
const sectionList = it => esc(it.tags.join(' · ').replace(/-/g, ' '));

/* The lowest price the database has ever seen for this product, when it is below today's. */
function lowNote(it) {
  const r = emag.get(it.id) || {};
  if (r.low == null || r.price == null || r.low >= r.price - 0.01) return '';
  return '<span class="low" title="The lowest eMag price this server has recorded">low '
    + lei(r.low) + '</span>';
}
/* A sparkline of whatever price points the database holds. Six or seven at most, so a plain
   polyline says it better than anything cleverer. */
function spark(it) {
  const h = (emag.get(it.id) || {}).hist || [];
  if (h.length < 2) return '';
  const vs = h.map(p => p[1]);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
  const pts = vs.map((v, i) => (i / (vs.length - 1) * 60).toFixed(1) + ','
    + (16 - (v - lo) / span * 14).toFixed(1)).join(' ');
  return '<svg class="spark" viewBox="0 0 60 18" aria-hidden="true" title="' + vs.length
    + ' price points"><polyline points="' + pts + '"/></svg>';
}
function pickBadge(it) {
  const p = picks.get(it.id);
  if (!p) return '';
  if (p.bought >= p.qty) return '<span class="badge done">bought ×' + p.qty + '</span>';
  if (p.bought) return '<span class="badge part">' + p.bought + ' of ' + p.qty + ' bought</span>';
  return '<span class="badge">on the budget' + (p.qty > 1 ? ' ×' + p.qty : '') + '</span>';
}

/* ---------------------------------------------------------------- the catalog */
function card(it) {
  const r = emag.get(it.id) || {};
  const d = diffOf(it);
  const weak = r.score != null && r.score < 0.45;
  const p = picks.get(it.id);
  return '<article class="card' + (p && p.bought >= p.qty ? ' bought' : '') + '" data-id="' + it.id + '">'
    + '<div class="pic">' + pic(r) + sticker(d) + '</div>'
    + '<div class="body">'
    + '<p class="brand">' + esc(it.brand || '—') + pickBadge(it) + '</p>'
    + '<h3 title="' + esc(it.name) + '">' + esc(nice(it.name)) + '</h3>'
    + '<p class="match' + (weak ? ' weak' : '') + '">' + (r.title ? (weak ? 'closest match: ' : '') + esc(r.title) : '') + '</p>'
    + '<div class="prices">'
    + '<span><small>my list</small>' + lei(it.price) + '</span>'
    + '<span><small>eMag ' + spark(it) + '</small>' + theirs(it) + lowNote(it) + '</span>'
    + '</div></div>'
    + '<div class="acts">'
    + '<button class="ico' + (wish.has(it.id) ? ' on' : '') + '" data-act="wish" type="button" title="Like this one" aria-label="Like this one">' + HEART + '</button>'
    + '<button class="ico' + (inCmp(it) ? ' on' : '') + '" data-act="cmp" type="button" title="Add to compare" aria-label="Add to compare">' + SCALE + '</button>'
    + '<button class="ico' + (p ? ' on' : '') + '" data-act="pick" type="button" title="Put on the budget" aria-label="Put on the budget">' + CART + '</button>'
    + '<button class="ico" data-act="again" type="button" title="Ask eMag again (force refresh)" aria-label="Ask eMag again">' + AGAIN + '</button>'
    + '<a href="' + esc(linkFor(it)) + '" target="_blank" rel="noopener noreferrer">Open in eMag</a>'
    + '</div></article>';
}
function paint(it) {
  const el = $('#grid > [data-id="' + it.id + '"]');
  if (!el) return;
  const box = document.createElement('div');
  box.innerHTML = card(it);
  el.replaceWith(box.firstElementChild);
}
function renderCatalog(keepScroll) {
  RESULTS = filtered();
  const pages = Math.max(1, Math.ceil(RESULTS.length / PER));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = RESULTS.slice(page * PER, page * PER + PER);
  const g = $('#grid');
  g.innerHTML = rows.map(card).join('');
  $('#empty').hidden = rows.length > 0;
  for (const el of g.children) {
    const it = byId.get(+el.dataset.id);
    if (it && !emag.has(it.id)) watcher.observe(el);
  }
  tally();
  pager(pages);
  if (!keepScroll) window.scrollTo({ top: 0 });
}
function tally() {
  let n = 0;
  for (const it of RESULTS) { const r = emag.get(it.id); if (r && r.price != null) n++; }
  $('#count').innerHTML = '<strong>' + ro(RESULTS.length) + '</strong> products · ' + ro(n) + ' priced on eMag';
}
function pager(pages) {
  const near = [0, 1, page - 1, page, page + 1, pages - 2, pages - 1]
    .filter(p => p >= 0 && p < pages)
    .sort((a, b) => a - b)
    .filter((p, i, a) => p !== a[i - 1]);
  let html = '<button class="pg" data-go="' + (page - 1) + '"' + (page === 0 ? ' disabled' : '') + '>‹ Back</button>';
  near.forEach((p, i) => {
    if (i && p !== near[i - 1] + 1) html += '<span class="gap">…</span>';
    html += '<button class="pg' + (p === page ? ' on' : '') + '" data-go="' + p + '">' + (p + 1) + '</button>';
  });
  html += '<button class="pg" data-go="' + (page + 1) + '"' + (page >= pages - 1 ? ' disabled' : '') + '>Next ›</button>';
  $('#pager').innerHTML = html;
  $('#pageNote').textContent = 'page ' + ro(page + 1) + ' of ' + ro(pages);
}

/* ---------------------------------------------------------------- sections (tags) */
/* With "any of them" the rail counts what each section would give you under the rest of the
   filters, ignoring the sections already ticked -- so the numbers do not collapse to nothing as
   you pick. With "all of them" it counts inside what is already left, which is what makes the
   rail prune itself: a section that would empty the page is simply not offered. */
function tagCounts() {
  const base = F.match === 'all' && F.tags.length ? filtered() : filtered({ skipTags: true });
  const n = new Map();
  for (const it of base) for (const t of it.tags) n.set(t, (n.get(t) || 0) + 1);
  return n;
}
function renderTags() {
  const box = $('#tagBox');
  box.hidden = !SET.tagsOpen;
  $('#tagsOpen').setAttribute('aria-expanded', SET.tagsOpen ? 'true' : 'false');
  $('#tagsOpen').classList.toggle('on', SET.tagsOpen || !!F.tags.length);
  $('#nTags').textContent = F.tags.length ? F.tags.length : '';
  $$('#tagBox [data-match]').forEach(b => {
    const on = b.dataset.match === F.match;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  if (!SET.tagsOpen) return;

  const n = tagCounts();
  const pruning = F.match === 'all' && F.tags.length > 0;
  let shown = 0;
  $('#tagRail').innerHTML = TAGS.map(t => {
    const on = F.tags.includes(t.name);
    const c = on ? (n.get(t.name) || 0) : (n.get(t.name) || 0);
    if (!on && !c) return '';
    shown++;
    return '<button class="chip' + (on ? ' on' : '') + '" data-tag="' + esc(t.name) + '" type="button"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
      + esc(t.name.replace(/-/g, ' ')) + '<small>' + ro(c) + '</small></button>';
  }).join('');
  $('#tagHint').textContent = pruning
    ? shown + ' of ' + TAGS.length + ' sections still have something in them'
    : 'A product carries every section it was listed under.';
}

/* ---------------------------------------------------------------- top deals */
function renderDeals() {
  const v = $('#view-deals');
  const pool = filtered();
  const rows = pool.map(it => ({ it, d: diffOf(it) }))
    .filter(x => x.d && x.d.d > 0 && x.d.p >= D.min)
    .sort((a, b) => b.d.p - a.d.p);
  const unknown = pool.filter(it => !emag.has(it.id)).length;
  const top = rows.slice(0, 3), rest = rows.slice(3, 60);

  const podium = top.map((x, i) => {
    const r = emag.get(x.it.id);
    return '<article class="deal' + (i === 0 ? ' first' : '') + '" data-id="' + x.it.id + '">'
      + '<span class="rank">' + (i + 1) + '</span>'
      + '<div class="pic">' + pic(r) + sticker(x.d) + '</div>'
      + '<div class="body"><p class="brand">' + esc(x.it.brand || '—') + pickBadge(x.it) + '</p>'
      + '<h3 title="' + esc(x.it.name) + '">' + esc(nice(x.it.name)) + '</h3>'
      + '<div class="prices"><span><small>my list</small>' + lei(x.it.price) + '</span>'
      + '<span><small>eMag</small><strong>' + lei(r.price) + '</strong></span></div></div>'
      + '<div class="acts">'
      + '<button class="ico' + (wish.has(x.it.id) ? ' on' : '') + '" data-act="wish" type="button" aria-label="Like this one">' + HEART + '</button>'
      + '<button class="ico' + (inCmp(x.it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '<button class="ico' + (picks.has(x.it.id) ? ' on' : '') + '" data-act="pick" type="button" aria-label="Put on the budget">' + CART + '</button>'
      + '<a href="' + esc(linkFor(x.it)) + '" target="_blank" rel="noopener noreferrer">Open in eMag</a>'
      + '</div></article>';
  }).join('');

  const list = rest.map((x, i) => {
    const r = emag.get(x.it.id);
    return '<div class="row-item" data-id="' + x.it.id + '">'
      + '<span class="rank sm">' + (i + 4) + '</span>'
      + '<div class="thumb">' + pic(r) + '</div>'
      + '<div class="rmain"><p class="t" data-act="emag" title="' + esc(x.it.name) + '">' + esc(nice(x.it.name)) + '</p>'
      + '<p class="brand">' + esc(x.it.brand || '—') + ' · ' + sectionList(x.it) + pickBadge(x.it) + '</p></div>'
      + '<div class="rp"><strong>' + lei(x.it.price) + '</strong><small>eMag ' + lei(r.price) + '</small></div>'
      + '<div class="rd">' + sticker(x.d) + '</div>'
      + '<div class="ract">'
      + '<button class="ico' + (wish.has(x.it.id) ? ' on' : '') + '" data-act="wish" type="button" aria-label="Like this one">' + HEART + '</button>'
      + '<button class="ico' + (picks.has(x.it.id) ? ' on' : '') + '" data-act="pick" type="button" aria-label="Put on the budget">' + CART + '</button>'
      + '<button class="ico' + (inCmp(x.it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '</div></div>';
  }).join('');

  v.innerHTML = head('Top deals',
    'Where the list beats eMag by the widest margin, out of the '
    + ro(pool.length - unknown) + ' of ' + ro(pool.length) + ' products checked so far'
    + (anyFilter() ? ' in the current filter' : '') + '. '
    + (unknown ? 'Checking more widens the search.' : 'Everything here has been checked.'),
    '<label class="inline">At least <select id="dMin" class="in">'
    + [0, 5, 10, 20, 30, 50].map(p => '<option value="' + p + '"' + (D.min === p ? ' selected' : '') + '>' + (p ? p + '%' : 'any') + '</option>').join('')
    + '</select> cheaper</label>'
    + (unknown ? '<button class="btn" id="dScan" type="button">Check ' + ro(Math.min(unknown, D.batch)) + ' more</button>' : '')
    + '<button class="ghost" data-stop type="button" hidden>Stop</button>'
    + '<span class="prog" data-prog></span>')
    + (rows.length
      ? '<div class="podium">' + podium + '</div>' + (rest.length ? '<div class="rows">' + list + '</div>' : '')
      : '<div class="box">Nothing beats eMag here yet'
        + (D.min ? ', by ' + D.min + '% or more' : '') + '. '
        + (unknown ? 'Check some more and they will appear.' : 'Try a smaller margin, or widen the filter.')
        + '</div>')
    + (rows.length ? '<div class="headtools end">'
      + '<button class="ghost" id="dCsv" type="button">Download these as CSV</button>'
      + '<button class="ghost" id="dLike" type="button">Like the top ' + Math.min(rows.length, 20) + '</button>'
      + '</div>' : '')
    + (rows.length > 60 ? '<p class="foot">Showing the best 60 of ' + ro(rows.length) + '.</p>' : '');

  const mn = $('#dMin', v);
  if (mn) mn.onchange = e => { D.min = +e.target.value; renderDeals(); };
  const sc = $('#dScan', v);
  if (sc) sc.onclick = () => {
    const n = askMany(pool, D.batch);
    toast(n ? 'Checking ' + ro(n) + ' products on eMag…' : 'Nothing left to check here');
  };
  const dc = $('#dCsv', v);
  if (dc) dc.onclick = () => csv(rows.map(x => x.it), 'top-deals');
  const dl = $('#dLike', v);
  if (dl) dl.onclick = () => {
    rows.slice(0, 20).forEach(x => wish.add(x.it.id));
    saveWish();
    toast('Liked the top ' + Math.min(rows.length, 20));
    renderDeals();
  };
  progress();
}

/* ---------------------------------------------------------------- liked */
const likedItems = () => [...wish].map(id => byId.get(id)).filter(Boolean);
function totals(items) {
  let mine = 0, them = 0, gap = 0, missing = 0;
  for (const it of items) {
    mine += it.price || 0;
    const r = emag.get(it.id);
    if (r && r.price != null && it.price != null) { them += r.price; gap += r.price - it.price; }
    else missing++;
  }
  return { mine, them, gap, missing };
}
function renderLiked() {
  const v = $('#view-liked');
  const items = likedItems();
  const T = totals(items);
  const over = SET.budget && T.mine > SET.budget;
  const used = SET.budget ? Math.min(100, T.mine / SET.budget * 100) : 0;

  const rows = items.map(it => {
    const r = emag.get(it.id) || {}, d = diffOf(it);
    return '<div class="row-item" data-id="' + it.id + '">'
      + '<div class="thumb">' + pic(r) + '</div>'
      + '<div class="rmain"><p class="t" data-act="emag" title="' + esc(it.name) + '">' + esc(nice(it.name)) + '</p>'
      + '<p class="brand">' + esc(it.brand || '—') + ' · ' + sectionList(it) + pickBadge(it) + '</p></div>'
      + '<div class="rp"><strong>' + lei(it.price) + '</strong><small>eMag ' + (r.price != null ? lei(r.price) : '—') + '</small></div>'
      + '<div class="rd">' + (d ? sticker(d) : '<span class="na">' + (r.busy ? 'asking…' : r.err ? 'no price' : 'not checked') + '</span>') + '</div>'
      + '<div class="ract">'
      + '<button class="ico' + (picks.has(it.id) ? ' on' : '') + '" data-act="pick" type="button" aria-label="Put on the budget">' + CART + '</button>'
      + '<button class="ico' + (inCmp(it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '<button class="ico on" data-act="wish" type="button" aria-label="Remove from liked">' + HEART + '</button>'
      + '</div></div>';
  }).join('');

  v.innerHTML = head('Liked',
    items.length ? ro(items.length) + ' products kept in this browser.' : 'Nothing liked yet.',
    items.length
      ? '<button class="btn" id="lLoad" type="button"' + (T.missing ? '' : ' disabled') + '>Check ' + ro(T.missing) + ' on eMag</button>'
        + '<button class="ghost" data-stop type="button" hidden>Stop</button><span class="prog" data-prog></span>'
      : '')
    + (!items.length
      ? '<div class="box">Press the heart on any product and it lands here, with the totals and a budget.'
        + '<p><a class="btn" href="#/catalog">Go to the catalog</a></p></div>'
      : '<div class="stats">'
        + '<div class="stat"><span>Products</span><strong>' + ro(items.length) + '</strong></div>'
        + '<div class="stat"><span>Total on my list</span><strong>' + lei(T.mine) + '</strong></div>'
        + '<div class="stat"><span>The checked ones, on eMag</span><strong>' + (T.them ? lei(T.them) : '—') + '</strong></div>'
        + '<div class="stat ' + (T.gap >= 0 ? 'good' : 'bad') + '"><span>'
        + (T.gap >= 0 ? 'Cheaper on my list by' : 'Cheaper on eMag by') + '</span><strong>'
        + (T.them ? lei(Math.abs(T.gap)) : '—') + '</strong></div>'
        + '</div>'
        + (T.missing ? '<p class="note-in">' + ro(T.missing) + ' of them have no eMag price yet, so they stay out of the eMag total.</p>' : '')
        + '<div class="panel tight">'
        + '<form class="inline" id="bForm"><label for="bVal">Spending cap for this list</label>'
        + '<input id="bVal" class="in" name="b" type="number" inputmode="decimal" min="0" step="any" value="' + (SET.budget == null ? '' : SET.budget) + '" placeholder="e.g. 5000">'
        + '<span class="note-in">lei</span><button class="ghost" type="submit">Set</button>'
        + (SET.budget ? '<button class="ghost" type="button" id="bClr">Remove</button>' : '') + '</form>'
        + (SET.budget ? '<div class="meter' + (over ? ' over' : '') + '"><span style="width:' + used + '%"></span></div>'
          + '<p class="note-in">' + (over ? 'Over by ' + lei(T.mine - SET.budget) : lei(SET.budget - T.mine) + ' left of ' + lei(SET.budget)) + '</p>' : '')
        + '</div>'
        + '<div class="rows">' + rows + '</div>'
        + '<div class="headtools end">'
        + '<button class="ghost" id="lShow" type="button">Show in the catalog</button>'
        + '<button class="ghost" id="lCmp" type="button">Compare the first four</button>'
        + '<button class="ghost" id="lBud" type="button">Send all to the budget</button>'
        + '<button class="ghost" id="lCsv" type="button">Download CSV</button>'
        + '<button class="ghost danger" id="lClr" type="button">Remove all</button>'
        + '</div>');

  if (!items.length) return;
  $('#bForm', v).onsubmit = e => {
    e.preventDefault();
    const n = parseFloat(String(e.target.b.value).replace(',', '.'));
    SET.budget = isNaN(n) || n <= 0 ? null : n;
    saveSet();
    renderLiked();
  };
  const bc = $('#bClr', v);
  if (bc) bc.onclick = () => { SET.budget = null; saveSet(); renderLiked(); };
  $('#lLoad', v).onclick = () => {
    const n = askMany(items, 400);
    toast(n ? 'Checking ' + ro(n) + ' on eMag…' : 'All of them have been checked');
  };
  $('#lShow', v).onclick = () => {
    F.onlyWish = true;
    $('#onlyWish').checked = true;
    page = 0;
    location.hash = '#/catalog';
  };
  $('#lCmp', v).onclick = () => { cmp = [...wish].slice(0, 4); saveCmp(); location.hash = '#/compare'; };
  $('#lCsv', v).onclick = () => csv(items, 'liked');
  $('#lBud', v).onclick = async () => {
    if (!budgetReady(true)) return;
    let n = 0;
    for (const it of items) if (!picks.has(it.id)) { await setPick(it.id, { qty: 1 }); n++; }
    toast(n ? n + ' sent to the budget' : 'They were all on the budget already');
    renderLiked();
  };
  $('#lClr', v).onclick = () => {
    if (!confirm('Remove all ' + items.length + ' liked products?')) return;
    wish.clear();
    saveWish();
    renderLiked();
  };
  progress();
}

/* ---------------------------------------------------------------- the budget */
let BUD = null;        // what /api/budget last said
let BUDBUSY = false;

function budgetReady(say) {
  if (!BE) { if (say) toast('The budget lives on the self-hosted copy, which has a server to keep it on.'); return false; }
  if (!ME) { if (say) toast('Sign in on the Budget page first.'); return false; }
  return true;
}
async function pullBudget() {
  if (!budgetReady()) { BUD = null; picks.clear(); return; }
  try {
    BUD = await API('budget');
    picks.clear();
    for (const it of BUD.items) if (it.pick) picks.set(it.id, it.pick);
    /* The budget page knows prices the catalog has not asked for yet; keep them. */
    for (const it of BUD.items) {
      if (it.emag && !emag.has(it.id)) {
        emag.set(it.id, Object.assign({ t: Date.now() }, it.emag));
      }
    }
    badges();
  } catch (e) { BUD = null; }
}
async function setPick(id, patch) {
  const j = await API('budget/pick', { method: 'POST', body: Object.assign({ id: id }, patch) });
  if (j.pick) picks.set(+id, j.pick); else picks.delete(+id);
  badges();
  return j;
}

function loginPanel(note) {
  return '<div class="panel narrow"><h3>' + (BE && BE.anyUser ? 'Sign in' : 'Make your profile') + '</h3>'
    + '<p class="note-in">' + esc(note) + '</p>'
    + '<form id="logForm" class="stack" autocomplete="on">'
    + '<label for="lgU">Username</label>'
    + '<input id="lgU" class="in" name="user" autocomplete="username" required minlength="2" maxlength="40">'
    + '<label for="lgP">Password</label>'
    + '<input id="lgP" class="in" name="pass" type="password" autocomplete="current-password" required minlength="8">'
    + '<div class="inline"><button class="btn" type="submit">'
    + (BE && BE.anyUser ? 'Sign in' : 'Create it') + '</button>'
    + (BE && BE.anyUser ? '<button class="ghost" type="button" id="lgNew">Make another profile</button>' : '')
    + '<span class="note-in" id="lgOut"></span></div></form>'
    + '<p class="note-in">This is a profile on <em>this</em> box and nowhere else: a name, a password kept '
    + 'as a scrypt hash, and the budget it belongs to. It is not your eMag account and it is not '
    + 'connected to one.</p></div>';
}
function wireLogin(v, after) {
  let mode = BE && BE.anyUser ? 'login' : 'signup';
  const nb = $('#lgNew', v);
  if (nb) nb.onclick = () => { mode = 'signup'; $('#lgOut', v).textContent = 'Pick a name and a password of at least eight characters.'; };
  $('#logForm', v).onsubmit = async e => {
    e.preventDefault();
    const out = $('#lgOut', v);
    out.textContent = 'one moment…';
    try {
      const j = await API(mode, { method: 'POST', body: { user: e.target.user.value, pass: e.target.pass.value } });
      ME = j.user;
      if (BE) BE.anyUser = true;
      await pullBudget();
      toast('Signed in as ' + ME);
      after();
    } catch (err) { out.textContent = err.message; }
  };
}

function renderBudget() {
  const v = $('#view-budget');

  if (!BE) {
    v.innerHTML = head('Budget', 'A spending plan the server keeps for you.', '')
      + '<div class="box">This copy of the page has no server behind it, so there is nowhere to keep a '
      + 'budget, a profile or a watcher. Open the self-hosted copy &mdash; <code>docker compose up -d --build</code> '
      + 'and the address its tunnel prints &mdash; and the page you are reading grows all three.'
      + '<p class="note-in">Liked products and the compare picks work here as they always did.</p></div>';
    return;
  }
  if (!ME) {
    v.innerHTML = head('Budget', 'A spending plan the server keeps for you.', '')
      + loginPanel('The budget, the picks and the watcher belong to a profile on this server.');
    wireLogin(v, renderBudget);
    return;
  }
  if (!BUD) {
    v.innerHTML = head('Budget', '', '') + '<div class="box">Fetching your budget…</div>';
    pullBudget().then(renderBudget);
    return;
  }

  const b = BUD.budget;
  const items = BUD.items.slice().sort((x, y) => {
    const a = picks.get(x.id) || {}, c = picks.get(y.id) || {};
    return (a.bought >= a.qty) - (c.bought >= c.qty) || (c.added || 0) - (a.added || 0);
  });

  let planned = 0, spent = 0, atEmag = 0, ready = 0;
  for (const it of items) {
    const p = picks.get(it.id) || { qty: 1, bought: 0 };
    const unit = it.price == null ? 0 : it.price;
    planned += unit * p.qty;
    spent += (p.boughtPrice != null ? p.boughtPrice : unit) * p.bought;
    if (it.emag && it.emag.price != null) atEmag += it.emag.price * p.qty;
    if (it.emag && it.emag.price != null && limitOf(it, p) != null && it.emag.price <= limitOf(it, p)) ready++;
  }
  const cap = b.cap || 0;
  const used = cap ? Math.min(100, planned / cap * 100) : 0;
  const over = cap && planned > cap;

  const rows = items.map(it => {
    const p = picks.get(it.id) || { qty: 1, bought: 0, target: null };
    const r = emag.get(it.id) || it.emag || {};
    const lim = limitOf(it, p);
    const hit = r.price != null && lim != null && r.price <= lim;
    const done = p.bought >= p.qty;
    return '<div class="row-item' + (done ? ' done' : '') + '" data-id="' + it.id + '">'
      + '<div class="thumb">' + pic(r) + '</div>'
      + '<div class="rmain"><p class="t" data-act="emag" title="' + esc(it.name) + '">' + esc(nice(it.name)) + '</p>'
      + '<p class="brand">' + esc(it.brand || '—') + ' · list ' + lei(it.price)
      + ' · eMag ' + (r.price != null ? lei(r.price) : 'not checked')
      + (hit ? ' <span class="badge done">within reach</span>' : '')
      + (done ? ' <span class="badge done">bought</span>' : '') + '</p></div>'
      + '<label class="qty"><span class="sr">Quantity</span>'
      + '<button class="stepper" data-act="less" type="button" aria-label="One fewer">−</button>'
      + '<b>' + p.qty + '</b>'
      + '<button class="stepper" data-act="more" type="button" aria-label="One more">+</button></label>'
      + '<div class="rp"><input class="in sm" data-act="target" type="number" min="0" step="any" '
      + 'value="' + (p.target == null ? '' : p.target) + '" placeholder="' + (it.price == null ? 'target' : Math.round(it.price)) + '" '
      + 'aria-label="Price I would pay"><small>target, lei</small></div>'
      + '<div class="rd"><small class="note-in">buy at ≤ ' + (lim == null ? '—' : lei(lim)) + '</small></div>'
      + '<div class="ract">'
      + '<button class="ghost sm' + (done ? ' on' : '') + '" data-act="bought" type="button">'
      + (done ? 'Bought' : 'Mark bought') + '</button>'
      + '<button class="ico" data-act="again" type="button" aria-label="Ask eMag again">' + AGAIN + '</button>'
      + '<button class="ico" data-act="drop" type="button" aria-label="Take off the budget">×</button>'
      + '</div></div>';
  }).join('');

  const alerts = (BUD.alerts || []).map(a =>
    '<li class="' + (a.kind === 'reached' ? 'hit' : '') + '"><span class="when">' + ago(a.t) + '</span> '
    + (a.kind === 'reached' ? '<strong>within reach:</strong> ' : 'price moved: ')
    + '<a href="' + esc(a.url || '#') + '" target="_blank" rel="noopener noreferrer">' + esc(nice(a.name).slice(0, 80)) + '</a>'
    + ' — ' + lei(a.price) + (a.was != null && a.was !== a.price ? ' (was ' + lei(a.was) + ')' : '')
    + (a.limit != null ? ', your limit ' + lei(a.limit) : '') + '</li>').join('');

  v.innerHTML = head('Budget',
    'Signed in as <strong>' + esc(ME) + '</strong>. Pick what you want off the list, say what you '
    + 'would pay, and the watcher tells you when eMag gets there.',
    '<button class="ghost" id="buRun" type="button">Check them all now</button>'
    + '<button class="ghost" id="buOut" type="button">Sign out</button>')

    + '<div class="stats">'
    + '<div class="stat"><span>Planned</span><strong>' + lei(planned) + '</strong></div>'
    + '<div class="stat"><span>Already bought</span><strong>' + lei(spent) + '</strong></div>'
    + '<div class="stat"><span>The same basket on eMag</span><strong>' + (atEmag ? lei(atEmag) : '—') + '</strong></div>'
    + '<div class="stat ' + (ready ? 'good' : '') + '"><span>Within reach now</span><strong>' + ro(ready) + '</strong></div>'
    + '</div>'

    + '<div class="panels two">'
    + '<div class="panel"><h3>The envelope</h3>'
    + '<div class="inline"><label for="buCap">Budget</label>'
    + '<input id="buCap" class="in" type="number" min="0" step="any" value="' + (cap || '') + '" placeholder="e.g. 5000">'
    + '<span class="note-in">lei</span></div>'
    + (cap ? '<div class="meter' + (over ? ' over' : '') + '"><span style="width:' + used + '%"></span></div>'
      + '<p class="note-in">' + (over ? 'Over by ' + lei(planned - cap) : lei(cap - planned) + ' still unspent of ' + lei(cap)) + '</p>' : '')
    + '<div class="inline"><button class="btn" id="buFill" type="button">Fill it with the best savings</button></div>'
    + '<p class="note-in">Takes the biggest savings in the current catalog filter, cheapest first, until the '
    + 'budget is used up.</p></div>'

    + '<div class="panel"><h3>The watcher</h3>'
    + '<label class="check wide"><input type="checkbox" id="buOn"' + (b.on ? ' checked' : '') + '> '
    + 'Keep checking these prices in the background</label>'
    + '<div class="inline"><label for="buMar">Margin</label>'
    + '<input id="buMar" class="in sm" type="number" min="0" max="50" step="0.5" value="' + b.margin + '"><span class="note-in">% over the target still counts</span></div>'
    + '<div class="inline"><label for="buInt">Every</label>'
    + '<input id="buInt" class="in sm" type="number" min="5" max="1440" value="' + b.interval + '"><span class="note-in">minutes</span>'
    + '<label for="buHr">from</label>'
    + '<select id="buHr" class="in sm">' + Array.from({ length: 24 }, (x, h) =>
      '<option value="' + h + '"' + (b.startHour === h ? ' selected' : '') + '>' + String(h).padStart(2, '0') + ':00</option>').join('')
    + '</select></div>'
    + '<p class="note-in">Last pass ' + ago(b.lastRun) + '. The watcher wakes every '
    + (BUD.watcher ? BUD.watcher.every : 60) + 's and acts when your interval is up.</p>'
    + '<p class="warnline">It watches and tells you; it does not buy. Ordering would mean keeping your eMag '
    + 'username and password on this box and replaying them at a shop whose terms forbid it, so when a price '
    + 'lands the alert carries the link and you decide.</p></div>'
    + '</div>'

    + (items.length
      ? '<div class="rows budget-rows">' + rows + '</div>'
        + '<div class="headtools end">'
        + '<button class="ghost" id="buCheck" type="button">Refresh every price</button>'
        + '<button class="ghost" data-stop type="button" hidden>Stop</button><span class="prog" data-prog></span>'
        + '<button class="ghost" id="buCsv" type="button">Download CSV</button>'
        + '<button class="ghost danger" id="buClr" type="button">Take everything off</button></div>'
      : '<div class="box">Nothing on the budget yet. Press the basket on any product, or let '
        + '<em>Fill it with the best savings</em> do it for you.'
        + '<p><a class="btn" href="#/deals">Go to the top deals</a></p></div>')

    + '<div class="panel"><h3>What the watcher has seen</h3>'
    + (alerts ? '<ul class="log">' + alerts + '</ul>'
      + '<div class="inline"><button class="ghost" id="buAlClr" type="button">Clear the log</button></div>'
      : '<p class="note-in">Nothing yet. With the watcher on, every price that drops or comes within reach '
        + 'is written down here.</p>')
    + '</div>';

  /* -- wiring -- */
  const push = debounce(async () => {
    try {
      await API('budget', { method: 'PUT', body: {
        cap: $('#buCap', v).value, margin: $('#buMar', v).value,
        interval: $('#buInt', v).value, startHour: $('#buHr', v).value, on: $('#buOn', v).checked,
      } });
      await pullBudget();
      renderBudget();
    } catch (e) { toast('Could not save: ' + e.message); }
  }, 500);
  ['#buCap', '#buMar', '#buInt'].forEach(s => { $(s, v).onchange = push; });
  $('#buHr', v).onchange = push;
  $('#buOn', v).onchange = push;

  $('#buOut', v).onclick = async () => {
    await API('logout', { method: 'POST' }).catch(() => {});
    ME = null; BUD = null; picks.clear(); badges();
    renderBudget();
  };
  $('#buRun', v).onclick = async () => {
    try {
      await API('watch/run', { method: 'POST' });
      toast('The watcher is going through your list now');
      setTimeout(() => pullBudget().then(renderBudget), 4000);
    } catch (e) { toast(e.message); }
  };
  $('#buFill', v).onclick = async () => {
    if (BUDBUSY) return;
    BUDBUSY = true;
    try {
      const j = await API('budget/fill', { method: 'POST', body: {
        filter: { q: F.q, brand: F.brand, tags: F.tags.join(','), match: F.match, min: F.min, max: F.max },
      } });
      toast(j.added.length ? j.added.length + ' added, ' + lei(j.spent) + ' of ' + lei(j.cap) + ' planned'
        : 'Nothing else fits in the budget');
      await pullBudget();
      renderBudget();
    } catch (e) { toast(e.message); } finally { BUDBUSY = false; }
  };
  const bch = $('#buCheck', v);
  if (bch) bch.onclick = () => {
    const its = items.map(i => byId.get(i.id)).filter(Boolean);
    askMany(its, 200, true);
    toast('Asking eMag again for ' + its.length + '…');
  };
  const bcs = $('#buCsv', v);
  if (bcs) bcs.onclick = () => csv(items.map(i => byId.get(i.id)).filter(Boolean), 'budget');
  const bcl = $('#buClr', v);
  if (bcl) bcl.onclick = async () => {
    if (!confirm('Take all ' + items.length + ' products off the budget?')) return;
    for (const it of items) await setPick(it.id, { remove: true });
    await pullBudget();
    renderBudget();
  };
  const bac = $('#buAlClr', v);
  if (bac) bac.onclick = async () => {
    await API('alerts', { method: 'DELETE' }).catch(() => {});
    await pullBudget();
    renderBudget();
  };
  progress();
}
/* The price at which you said you would buy: your own target if you set one, otherwise the list
   price, with the margin as slack on top. The server works it out the same way. */
function limitOf(it, p) {
  const base = p && p.target != null ? p.target : it.price;
  if (base == null || !BUD) return null;
  return +(base * (1 + (BUD.budget.margin || 0) / 100)).toFixed(2);
}

/* ---------------------------------------------------------------- compare */
function toggleCmp(it) {
  if (inCmp(it)) cmp = cmp.filter(x => x !== it.id);
  else if (cmp.length >= 4) return toast('Compare holds four. Take one out first.');
  else cmp.push(it.id);
  saveCmp();
}
function dock() {
  const d = $('#dock');
  if (!d) return;
  d.hidden = !cmp.length || VIEW === 'compare';
  $('#dockN').textContent = cmp.length ? '(' + cmp.length + ')' : '';
  $('#dockPics').innerHTML = cmp.map(id => byId.get(id)).filter(Boolean)
    .map(it => '<span>' + pic(emag.get(it.id)) + '</span>').join('');
}
/* The old build read each eMag product page for its specification table. This one never leaves the
   search results, so what is left to compare on is the name -- which, for this list, carries the
   numbers that matter anyway. */
function specs(it) {
  const out = {};
  const pick = (k, rx) => { const m = it.name.match(rx); if (m) out[k] = m[0].trim(); };
  pick('Power', /\b\d{2,5}\s?W\b/i);
  pick('Capacity', /\b\d+(?:[.,]\d+)?\s?(?:l|L|litri|ml)\b/);
  pick('Storage', /\b\d+\s?(?:GB|TB)\b(?!\s*RAM)/i);
  pick('RAM', /\b\d+\s?GB\s?RAM\b/i);
  pick('Screen', /\b\d{1,2}(?:[.,]\d)?\s?(?:"|inch|”)/i);
  pick('Battery', /\b\d{3,5}\s?mAh\b/i);
  pick('Speed', /\b\d{3,5}\s?(?:rpm|RPM)\b/);
  pick('Pressure', /\b\d{1,3}(?:[.,]\d)?\s?(?:bar|bari|Pa)\b/i);
  return { out, parts: it.name.split(/,\s*/).slice(1) };
}
function renderCompare() {
  const v = $('#view-compare');
  const items = cmp.map(id => byId.get(id)).filter(Boolean);
  if (!items.length) {
    v.innerHTML = head('Compare', '', '')
      + '<div class="box">Put up to four products side by side: press the scales on any card, then come back here.'
      + '<p><a class="btn" href="#/catalog">Go to the catalog</a></p></div>';
    return;
  }
  const missing = items.filter(it => !emag.has(it.id));
  /* the winner in a row, unless two of them tie for it */
  const win = (vals, mode) => {
    const xs = vals.filter(x => x != null);
    if (xs.length < 2) return -1;
    const b = mode === 'min' ? Math.min(...xs) : Math.max(...xs);
    return xs.filter(x => x === b).length > 1 ? -1 : vals.indexOf(b);
  };
  const rows = [];
  const add = (label, cells, bi = -1) => rows.push('<tr><th scope="row">' + esc(label) + '</th>'
    + cells.map((c, i) => '<td' + (i === bi ? ' class="best"' : '') + '>' + c + '</td>').join('') + '</tr>');

  const lp = items.map(i => i.price);
  const eps = items.map(ep);
  const ds = items.map(diffOf);
  add('My list price', lp.map(x => '<span class="num">' + lei(x) + '</span>'), win(lp, 'min'));
  add('eMag price', items.map(theirs), win(eps, 'min'));
  add('Saving vs eMag', ds.map(d => d ? sticker(d) : '—'), win(ds.map(d => d ? d.d : null), 'max'));
  const lows = items.map(i => { const r = emag.get(i.id) || {}; return r.low == null ? null : r.low; });
  if (lows.some(x => x != null)) add('Lowest eMag price seen', lows.map((x, i) =>
    (x == null ? '—' : '<span class="num">' + lei(x) + '</span>' + spark(items[i]))), win(lows, 'min'));
  add('Brand', items.map(i => esc(i.brand || '—')));
  add('Sections', items.map(i => i.tags.map(t => '<span class="chip sm">' + esc(t.replace(/-/g, ' ')) + '</span>').join(' ') || '—'));
  add('Matched on eMag', items.map(i => {
    const r = emag.get(i.id) || {};
    return r.title
      ? '<span class="' + (r.score < 0.45 ? 'weak' : '') + '">' + esc(r.title) + '</span>'
        + '<br><small class="note-in">confidence ' + Math.round((r.score || 0) * 100) + '%</small>'
      : '—';
  }));
  const ns = items.map(specs);
  for (const k of ['Power', 'Capacity', 'Storage', 'RAM', 'Screen', 'Battery', 'Speed', 'Pressure']) {
    if (ns.some(n => n.out[k])) add(k, ns.map(n => esc(n.out[k] || '—')));
  }
  add('From the name', ns.map(n => n.parts.length
    ? '<ul class="dets">' + n.parts.slice(0, 14).map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '—'));

  v.innerHTML = head('Compare',
    'Lowest price and biggest saving are marked. The specification rows are read out of the product name.',
    (missing.length ? '<button class="btn" id="cLoad" type="button">Check ' + missing.length + ' on eMag</button>' : '')
    + '<button class="ghost" id="cAgain" type="button">Refresh all four</button>'
    + '<button class="ghost" id="cCsv" type="button">Download CSV</button>'
    + '<button class="ghost danger" id="cClr" type="button">Clear</button>')
    + '<div class="cmpwrap"><table class="cmp"><thead><tr><th><span class="sr">Field</span></th>'
    + items.map(it => '<td><div class="cpic">' + pic(emag.get(it.id)) + '</div>'
      + '<p class="cname" title="' + esc(it.name) + '">' + esc(nice(it.name)) + '</p>'
      + '<div class="crow"><a href="' + esc(linkFor(it)) + '" target="_blank" rel="noopener noreferrer">Open in eMag</a>'
      + '<button class="link" data-rm="' + it.id + '" type="button">Remove</button></div></td>').join('')
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';

  $$('[data-rm]', v).forEach(b => b.onclick = () => {
    cmp = cmp.filter(x => x !== +b.dataset.rm);
    saveCmp();
    renderCompare();
  });
  $('#cClr', v).onclick = () => { cmp = []; saveCmp(); renderCompare(); };
  $('#cCsv', v).onclick = () => csv(items, 'compare');
  $('#cAgain', v).onclick = () => { askMany(items, 4, true); toast('Asking eMag again…'); };
  const cl = $('#cLoad', v);
  if (cl) cl.onclick = () => { askMany(items, 4); toast('Checking eMag…'); };
}

/* ---------------------------------------------------------------- settings */
const srcLine = () => BE
  ? 'This copy has a server behind it: it reads eMag, keeps every answer in its own database and '
    + 'never asks twice. Nothing to install.'
  : READER
    ? 'This copy has a reader on the server, so eMag prices load by themselves. Nothing to install.'
    : 'There is no reader on this address, so every request goes straight to emag.ro from your browser'
      + ' — which only gets through with the userscript installed.';

function renderSettings() {
  const v = $('#view-settings');
  const checked = [...emag.values()].filter(r => r.t).length;
  const priced = [...emag.values()].filter(r => r.price != null).length;
  const h = BE && BE.store;
  v.innerHTML = head('Settings', '', '') + '<div class="panels">'

    + '<div class="panel"><h3>Where eMag prices come from</h3>'
    + '<p class="' + (READER ? 'ok' : 'warnline') + '">' + esc(srcLine()) + '</p>'
    + '<p class="note-in">A page is not allowed to read emag.ro: the browser makes the request and then '
    + 'refuses to hand the reply to a script from another origin. A server is under no such rule, which '
    + 'is why the self-hosted copy needs nothing installed. On GitHub Pages there is no server, so '
    + '<a href="tools/emaglist.user.js">tools/emaglist.user.js</a> in Tampermonkey or Violentmonkey has '
    + 'to make the request instead.</p>'
    + '<div class="inline"><button class="btn" id="sTest" type="button">Test the connection</button>'
    + '<span class="note-in" id="sOut"></span></div></div>'

    + (BE ? '<div class="panel"><h3>This server</h3>'
      + '<dl class="kv">'
      + '<dt>List</dt><dd>' + ro(BE.catalog.count) + ' products, ' + BE.catalog.tags + ' sections, ' + ro(BE.catalog.brands) + ' brands</dd>'
      + '<dt>Database</dt><dd>' + ro(h.rows) + ' eMag rows, ' + Math.round(h.bytes / 1024) + ' KB'
      + (h.writable ? '' : ' <span class="warnline">— not writable, nothing is being kept</span>') + '</dd>'
      + '<dt>Profiles</dt><dd>' + h.users + (ME ? ', signed in as ' + esc(ME) : ', not signed in') + '</dd>'
      + '<dt>Watcher</dt><dd>' + (BE.watcher.on ? 'running, every ' + BE.watcher.every + 's' : 'off') + '</dd>'
      + '<dt>eMag reads</dt><dd>' + ro(BE.emag.reads) + (BE.emag.reads === 1 ? ' page, ' : ' pages, ') + ro(BE.emag.fails) + ' failed</dd>'
      + '</dl>'
      + '<div class="inline"><button class="ghost" id="sRefresh" type="button">Refresh these numbers</button>'
      + (ME ? '<button class="ghost danger" id="sWipeBe" type="button">Empty the server database</button>' : '')
      + '</div>'
      + '<p class="note-in">Every price on this page came out of that database. A card&rsquo;s refresh button, '
      + 'and <em>Refresh every price</em> on the budget, are what make the server ask eMag again.</p></div>' : '')

    + '<div class="panel"><h3>Loading</h3>'
    + '<label class="check wide"><input type="checkbox" id="sAuto"' + (SET.autoLoad ? ' checked' : '') + '> '
    + 'Ask eMag as cards reach the screen</label>'
    + '<p class="note-in">With this off nothing is fetched until you press a card&rsquo;s refresh button, or one '
    + 'of the check buttons on the other pages.</p>'
    + '<div class="inline"><label for="sPar">At once</label>'
    + '<input id="sPar" class="in sm" type="number" min="1" max="6" value="' + SET.parallel + '">'
    + '<label for="sKeep">Reuse an answer for</label>'
    + '<input id="sKeep" class="in sm" type="number" min="1" max="720" value="' + SET.keepHours + '"><span class="note-in">hours</span></div>'
    + '<p class="note-in">More at once is faster, until eMag starts refusing; three is a safe pace.</p></div>'

    + '<div class="panel"><h3>Saved eMag data</h3>'
    + '<p>' + ro(checked) + ' products checked in this browser, ' + ro(priced) + ' of them with a price.</p>'
    + '<div class="inline"><button class="ghost" id="sCsvAll" type="button">Download everything checked as CSV</button>'
    + '<button class="ghost danger" id="sWipe" type="button">Forget the saved prices</button></div></div>'

    + '<div class="panel"><h3>Backup</h3>'
    + '<p>Liked products, the compare picks, the soft budget, these settings and the saved eMag prices all live '
    + 'in this browser. A backup moves them to another one.</p>'
    + '<div class="inline"><button class="ghost" id="sExp" type="button">Download a backup</button>'
    + '<label class="ghost asbtn" for="sImp">Restore from a backup</label>'
    + '<input id="sImp" type="file" accept="application/json" hidden></div></div>'

    + '<div class="panel"><h3>Appearance</h3>'
    + '<div class="inline"><label for="sTheme">Theme</label><select id="sTheme" class="in">'
    + [['system', 'Match the device'], ['light', 'Light'], ['dark', 'Dark']].map(o =>
      '<option value="' + o[0] + '"' + (SET.theme === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select></div>'
    + '<label class="check wide"><input type="checkbox" id="sDense"' + (SET.dense ? ' checked' : '') + '> '
    + 'Tighter cards, more of them on screen</label></div>'

    + '<div class="panel"><h3>Keyboard</h3><dl class="kv">'
    + '<dt>/</dt><dd>jump to the search box</dd>'
    + '<dt>g then c d l b k s</dt><dd>catalog, deals, liked, budget, compare, settings</dd>'
    + '<dt>&larr; &rarr;</dt><dd>previous and next page of the catalog</dd>'
    + '<dt>f</dt><dd>show or hide the extra filters</dd>'
    + '<dt>t</dt><dd>show or hide the sections</dd>'
    + '<dt>Esc</dt><dd>clear the search box</dd></dl></div>'

    + '</div>';

  $('#sAuto', v).onchange = e => { SET.autoLoad = e.target.checked; saveSet(); };
  $('#sDense', v).onchange = e => { SET.dense = e.target.checked; saveSet(); applyTheme(); };
  $('#sPar', v).onchange = e => {
    SET.parallel = Math.max(1, Math.min(6, parseInt(e.target.value) || 3));
    e.target.value = SET.parallel;
    saveSet();
    pump();
  };
  $('#sKeep', v).onchange = e => {
    SET.keepHours = Math.max(1, Math.min(720, parseInt(e.target.value) || 24));
    e.target.value = SET.keepHours;
    saveSet();
  };
  $('#sTheme', v).onchange = e => { SET.theme = e.target.value; saveSet(); applyTheme(); };
  $('#sTest', v).onclick = async () => {
    const out = $('#sOut', v);
    out.textContent = 'Testing…';
    const it = ITEMS.find(i => i.name && i.name.length > 20) || ITEMS[0];
    const t0 = performance.now();
    try {
      if (BE) {
        const j = await API('emag/' + it.id + '?force=1');
        const ms = Math.round(performance.now() - t0);
        out.textContent = j.error ? 'The server tried and said: ' + j.error
          : 'Works: the server read eMag in ' + ro(ms) + ' ms and matched "'
            + String(j.emag.title).slice(0, 40) + '…" at ' + lei(j.emag.price) + '.';
        return;
      }
      const hits = parseSearch(await get(searchURL(it)));
      const ms = Math.round(performance.now() - t0);
      out.textContent = hits.length
        ? 'Works: ' + hits.length + ' eMag results in ' + ro(ms) + ' ms, '
          + (READER ? 'through the reader on this server.' : 'straight from this browser.')
        : 'The request got through in ' + ro(ms) + ' ms, but the page had no products on it. eMag may be '
          + 'serving a check page.';
    } catch (e) {
      out.textContent = 'Failed: ' + why(e);
    }
  };
  const sr = $('#sRefresh', v);
  if (sr) sr.onclick = async () => { await findReader(); renderSettings(); };
  const sw = $('#sWipeBe', v);
  if (sw) sw.onclick = async () => {
    if (!confirm('Empty the eMag database on the server? Every price will have to be read again.')) return;
    try { await API('forget', { method: 'POST' }); await findReader(); toast('The server database is empty'); renderSettings(); }
    catch (e) { toast(e.message); }
  };
  $('#sCsvAll', v).onclick = () => csv(ITEMS.filter(it => emag.has(it.id)), 'checked');
  $('#sWipe', v).onclick = () => {
    if (!confirm('Forget every saved eMag price and picture in this browser?')) return;
    emag.clear();
    save(STORE, {});
    toast('Saved eMag data forgotten');
    renderSettings();
  };
  $('#sExp', v).onclick = () => {
    const blob = new Blob([JSON.stringify({
      app: 'bfemag', v: 3, at: new Date().toISOString(),
      wish: [...wish], cmp: cmp, set: SET, emag: Object.fromEntries(emag),
    })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bfemag-backup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#sImp', v).onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.app !== 'bfemag') throw new Error('that is not a backup from this site');
      (j.wish || []).forEach(id => wish.add(id));
      saveWish();
      if (Array.isArray(j.cmp)) { cmp = j.cmp.slice(0, 4); saveCmp(); }
      Object.assign(SET, j.set || {});
      saveSet();
      applyTheme();
      const got = j.emag || {};
      for (const id in got) if (!emag.has(+id)) emag.set(+id, got[id]);
      saveStore();
      toast('Backup restored');
      renderSettings();
    } catch (err) {
      toast('Could not restore: ' + err.message);
    }
    e.target.value = '';
  };
}

/* ---------------------------------------------------------------- odds and ends */
/* Every page opens the same way, so it is one function rather than five near-copies. */
const head = (title, note, tools) => '<div class="page-head"><div><h2>' + esc(title) + '</h2>'
  + (note ? '<p class="note-in">' + note + '</p>' : '') + '</div>'
  + (tools ? '<div class="headtools">' + tools + '</div>' : '') + '</div>';

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 3200);
}
function csv(items, name) {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const head2 = ['nr', 'name', 'brand', 'sections', 'list price', 'eMag price', 'eMag old price',
    'lowest seen', 'difference', 'difference %', 'on the budget', 'quantity', 'bought',
    'matched name', 'match confidence', 'eMag link'];
  const body = items.map(it => {
    const r = emag.get(it.id) || {}, d = diffOf(it), p = picks.get(it.id);
    return [it.id, it.name, it.brand, it.tags.join(' '), it.price,
      r.price == null ? '' : r.price, r.old == null ? '' : r.old, r.low == null ? '' : r.low,
      d ? d.d.toFixed(2) : '', d ? d.p.toFixed(1) : '',
      p ? 'yes' : '', p ? p.qty : '', p ? p.bought : '',
      r.title || '', r.score == null ? '' : Math.round(r.score * 100), r.url || ''].map(q).join(',');
  });
  const blob = new Blob(['﻿' + [head2.map(q).join(','), ...body].join('\r\n')],
    { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bf-' + name + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(items.length + ' rows downloaded');
}
function badges() {
  $('#nWish').textContent = wish.size ? wish.size : '';
  $('#nCmp').textContent = cmp.length ? cmp.length : '';
  const nb = $('#nBud');
  if (nb) nb.textContent = picks.size ? picks.size : '';
}

/* One click handler for every list on every page: the cards, the deal rows, the liked rows, the
   budget rows. */
async function actOn(e) {
  const host = e.target.closest('[data-id]');
  const hit = e.target.closest('[data-act]');
  if (!host || !hit) return;
  const it = byId.get(+host.dataset.id);
  if (!it) return;
  const act = hit.dataset.act;
  const after = () => { if (VIEW === 'catalog') paint(it); else draw[VIEW](); };

  if (act === 'wish') {
    if (wish.has(it.id)) wish.delete(it.id); else wish.add(it.id);
    saveWish();
    after();
  }
  if (act === 'cmp') { toggleCmp(it); after(); }
  if (act === 'again') { ask(it, true); }
  if (act === 'emag') window.open(linkFor(it), '_blank', 'noopener');

  if (act === 'pick') {
    if (!budgetReady(true)) return;
    try {
      if (picks.has(it.id)) { await setPick(it.id, { remove: true }); toast('Taken off the budget'); }
      else { await setPick(it.id, { qty: 1 }); toast('On the budget'); }
      if (VIEW === 'budget') { await pullBudget(); renderBudget(); } else after();
    } catch (err) { toast(err.message); }
  }
  if (act === 'more' || act === 'less') {
    const p = picks.get(it.id);
    if (!p) return;
    const qty = Math.max(1, Math.min(99, p.qty + (act === 'more' ? 1 : -1)));
    await setPick(it.id, { qty });
    await pullBudget();
    renderBudget();
  }
  if (act === 'bought') {
    const p = picks.get(it.id);
    if (!p) return;
    const done = p.bought >= p.qty;
    const r = emag.get(it.id) || {};
    await setPick(it.id, { bought: done ? 0 : p.qty, boughtPrice: done ? null : (r.price != null ? r.price : it.price) });
    await pullBudget();
    renderBudget();
  }
  if (act === 'drop') {
    await setPick(it.id, { remove: true });
    await pullBudget();
    renderBudget();
  }
  if (act === 'target') { /* handled on change, not on click */ }
}

/* ---------------------------------------------------------------- the router */
const draw = {
  catalog: () => renderCatalog(true),
  deals: renderDeals,
  liked: renderLiked,
  budget: renderBudget,
  compare: renderCompare,
  settings: renderSettings,
};
/* Redraw the open page and then the sections rail, which counts what the page is showing. */
function drawAll() {
  draw[VIEW]();
  if (VIEW === 'catalog' || VIEW === 'deals') renderTags();
  syncHash();
}

/* The filters live in the address bar, so a filtered page is a link you can send or bookmark. */
function syncHash() {
  const p = new URLSearchParams();
  if (F.q) p.set('q', F.q);
  if (F.brand) p.set('b', F.brand);
  if (F.sort !== 'order') p.set('s', F.sort);
  if (F.tags.length) p.set('t', F.tags.join(','));
  if (F.match !== 'any') p.set('m', 'all');
  if (F.min !== '') p.set('lo', F.min);
  if (F.max !== '') p.set('hi', F.max);
  if (F.minPct) p.set('pc', F.minPct);
  if (F.state) p.set('st', F.state);
  if (F.pickState) p.set('pk', F.pickState);
  if (F.onlyWish) p.set('w', '1');
  if (page) p.set('p', page + 1);
  const want = '#/' + VIEW + (p.toString() ? '?' + p : '');
  if (location.hash !== want) history.replaceState(null, '', want);
}
function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, qs] = raw.split('?');
  const p = new URLSearchParams(qs || '');
  if (!qs) return draw[name] ? name : 'catalog';
  F.q = p.get('q') || '';
  F.brand = p.get('b') || '';
  F.sort = p.get('s') || 'order';
  F.tags = (p.get('t') || '').split(',').filter(Boolean);
  F.match = p.get('m') === 'all' ? 'all' : 'any';
  F.min = p.get('lo') || '';
  F.max = p.get('hi') || '';
  F.minPct = +(p.get('pc') || 0);
  F.state = p.get('st') || '';
  F.pickState = p.get('pk') || '';
  F.onlyWish = p.get('w') === '1';
  page = Math.max(0, (+p.get('p') || 1) - 1);
  showFilters();
  return draw[name] ? name : 'catalog';
}
/* Put F back on screen, after a hash read or a reset. */
function showFilters() {
  $('#q').value = F.q;
  $('#brand').value = F.brand;
  $('#sort').value = F.sort;
  $('#state').value = F.state;
  $('#min').value = F.min;
  $('#max').value = F.max;
  $('#minPct').value = String(F.minPct);
  $('#pickState').value = F.pickState;
  $('#onlyWish').checked = F.onlyWish;
  const n = [F.state, F.min !== '' ? 1 : '', F.max !== '' ? 1 : '', F.minPct, F.pickState].filter(Boolean).length;
  $('#nMore').textContent = n ? n : '';
  $('#moreBox').hidden = !SET.moreOpen;
  $('#moreOpen').setAttribute('aria-expanded', SET.moreOpen ? 'true' : 'false');
  $('#moreOpen').classList.toggle('on', SET.moreOpen || !!n);
}

function route() {
  VIEW = readHash();
  $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + VIEW; });
  $$('.views a').forEach(a => {
    const on = a.dataset.view === VIEW;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  /* The search bar belongs to the catalog and the deals, which both read it. The other pages put it
     away rather than leave it on screen doing nothing -- but the header count still follows the
     filters, so they refresh it before they draw. */
  $('#bar').hidden = !(VIEW === 'catalog' || VIEW === 'deals');
  if (VIEW !== 'catalog') { RESULTS = filtered(); tally(); }
  dock();
  draw[VIEW]();
  /* The budget lives on the server, where the watcher and any other tab can change it, so the
     page is drawn from what we have and then again from what the server says. */
  if (VIEW === 'budget' && budgetReady()) pullBudget().then(() => { if (VIEW === 'budget') renderBudget(); }).catch(() => {});
  if (VIEW === 'catalog' || VIEW === 'deals') renderTags();
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------------- wiring */
function wire() {
  const redraw = debounce(() => { page = 0; drawAll(); }, 220);
  const now = () => { page = 0; drawAll(); };

  $('#q').addEventListener('input', e => { F.q = e.target.value; redraw(); });
  $('#brand').addEventListener('input', e => { F.brand = e.target.value; redraw(); });
  $('#sort').onchange = e => { F.sort = e.target.value; now(); };
  $('#state').onchange = e => { F.state = e.target.value; showFilters(); now(); };
  $('#min').onchange = e => { F.min = e.target.value; showFilters(); now(); };
  $('#max').onchange = e => { F.max = e.target.value; showFilters(); now(); };
  $('#minPct').onchange = e => { F.minPct = +e.target.value; showFilters(); now(); };
  $('#pickState').onchange = e => { F.pickState = e.target.value; showFilters(); now(); };
  $('#onlyWish').onchange = e => { F.onlyWish = e.target.checked; now(); };

  $('#reset').onclick = () => {
    Object.assign(F, FRESH, { tags: [] });
    showFilters();
    renderTags();
    now();
  };
  $('#moreOpen').onclick = () => {
    SET.moreOpen = !SET.moreOpen;
    saveSet();
    showFilters();
  };
  $('#tagsOpen').onclick = () => {
    SET.tagsOpen = !SET.tagsOpen;
    saveSet();
    renderTags();
  };
  $('#tagsClose').onclick = () => { SET.tagsOpen = false; saveSet(); renderTags(); };
  $('#tagsClear').onclick = () => { F.tags = []; now(); renderTags(); };
  $('#tagRail').onclick = e => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag;
    F.tags = F.tags.includes(t) ? F.tags.filter(x => x !== t) : [...F.tags, t];
    page = 0;
    drawAll();
    renderTags();
  };
  $$('#tagBox [data-match]').forEach(b => b.onclick = () => {
    F.match = b.dataset.match;
    page = 0;
    drawAll();
    renderTags();
  });
  $('#share').onclick = async () => {
    syncHash();
    try { await navigator.clipboard.writeText(location.href); toast('Link to this view copied'); }
    catch (e) { toast('Copy the address bar: it carries every filter.'); }
  };
  $('#pager').onclick = e => {
    const b = e.target.closest('[data-go]');
    if (!b || b.disabled) return;
    page = +b.dataset.go;
    renderCatalog();
    syncHash();
  };
  $('main').onclick = actOn;
  /* The budget rows carry a target-price box each. */
  $('main').addEventListener('change', async e => {
    const inp = e.target.closest('[data-act="target"]');
    if (!inp) return;
    const host = inp.closest('[data-id]');
    if (!host) return;
    await setPick(+host.dataset.id, { target: inp.value === '' ? null : inp.value });
    await pullBudget();
    renderBudget();
  });
  document.body.addEventListener('click', e => { if (e.target.closest('[data-stop]')) stopAsking(); });
  $('#dockClear').onclick = () => { cmp = []; saveCmp(); };
  $('#theme').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    SET.theme = dark ? 'light' : 'dark';
    saveSet();
    applyTheme();
    if (VIEW === 'settings') renderSettings();
  };
  window.addEventListener('hashchange', route);

  /* Keys. Nothing fires while you are typing in a field. */
  let g = 0;
  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) {
      if (e.key === 'Escape' && e.target.id === 'q') { F.q = ''; e.target.value = ''; now(); }
      return;
    }
    if (Date.now() - g < 1200) {
      const to = { c: 'catalog', d: 'deals', l: 'liked', b: 'budget', k: 'compare', s: 'settings' }[e.key];
      g = 0;
      if (to) { location.hash = '#/' + to; return; }
    }
    if (e.key === 'g') { g = Date.now(); return; }
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
    if (e.key === 'f') { SET.moreOpen = !SET.moreOpen; saveSet(); showFilters(); return; }
    if (e.key === 't') { SET.tagsOpen = !SET.tagsOpen; saveSet(); renderTags(); return; }
    if (VIEW === 'catalog' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const pages = Math.max(1, Math.ceil(RESULTS.length / PER));
      const next = page + (e.key === 'ArrowRight' ? 1 : -1);
      if (next >= 0 && next < pages) { page = next; renderCatalog(); syncHash(); }
    }
  });
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  applyTheme();
  // The build before last kept the catalog in Cache Storage and its settings under el.*. Nothing
  // reads either any more, and a stale copy is the likeliest reason that build stopped loading on a
  // machine that had used it, so throw it out on the way past.
  try {
    caches.keys().then(ks => ks.forEach(k => /^emaglist-/.test(k) && caches.delete(k)));
    Object.keys(localStorage).forEach(k => k.indexOf('el.') === 0 && localStorage.removeItem(k));
  } catch (e) {}
  try {
    const [r] = await Promise.all([fetch('products.json'), findReader()]);
    if (!r.ok) throw new Error('products.json answered ' + r.status);
    const j = await r.json();
    ITEMS = j.items.map(row => ({
      id: row[0],
      name: row[1],
      price: row[2],
      brand: row[3] >= 0 ? j.brands[row[3]] : '',
      tags: row[4].map(i => j.tags[i]),
    }));
    for (const it of ITEMS) byId.set(it.id, it);
    /* Every word match.js uses is weighed by how rare it is across the whole list, so the list has
       to be counted once before any name can be turned into a query or compared with a title. It
       is counted here, where the 3.6 MB of JSON has just been parsed and a tenth of a second more
       does not show, rather than lazily later, where the first page of sixty cards would be
       building its eMag links with every word weighing the same. */
    MATCH.learn(ITEMS.map(i => i.name));

    const n = new Map();
    for (const it of ITEMS) for (const t of it.tags) n.set(t, (n.get(t) || 0) + 1);
    TAGS = [...n].map(e => ({ name: e[0], n: e[1] })).sort((a, b) => b.n - a.n);

    $('#brands').innerHTML = j.brands.map(b => '<option value="' + esc(b) + '">').join('');
    $('#srcFoot').textContent = srcLine();
    loadStore();
    await pullBudget();
    badges();
    wire();
    showFilters();
    $('#loading').remove();
    route();
  } catch (e) {
    $('#loading').innerHTML = '<p class="bad">Could not load the product list: ' + esc(e.message) + '</p>';
  }
})();
