/* BF list vs eMag.

   One hardcoded product list, shown a page at a time. A card asks eMag for its own price when it
   comes near the viewport, and never before: search by title, keep the closest-named result, show
   that price and picture.

   Five views, all off the same data and the same little lookup queue: the catalog, the best savings
   found so far, the ones you liked, up to four side by side, and the settings.

   Two ways to reach eMag, decided once at startup. Served from the Docker box there is a reader on
   this very origin (server.js) and nothing needs installing. Served from github.io there is not, so
   the request goes straight to emag.ro and only gets through with tools/emaglist.user.js in the
   browser -- the browser will otherwise fetch eMag's reply and refuse to hand it over. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nf = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ro = n => Number(n).toLocaleString('ro-RO');
const lei = v => v == null || isNaN(v) ? '—' : nf.format(v) + ' lei';
const pct = p => (p > 0 ? '−' : '+') + Math.abs(p).toFixed(0) + '%';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const nice = n => !n || n === '0' ? '(no name in the source list)' : n;

/* ---------------------------------------------------------------- settings */
const SET = Object.assign({
  theme: 'system',      // system | light | dark
  autoLoad: true,       // ask eMag as cards reach the screen
  parallel: 3,          // lookups in flight at once
  keepHours: 24,        // how long an answer is reused
  budget: null,         // on the liked page
}, load('bf.set', {}));
const saveSet = () => save('bf.set', SET);
function applyTheme() {
  if (SET.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = SET.theme;
}

/* ---------------------------------------------------------------- state */
const PER = 60;
let ITEMS = [], RESULTS = [], page = 0, TAGS = [], VIEW = 'catalog';
const byId = new Map();
const emag = new Map();   // id -> {busy:true} | {t,price,img,url,title,old,score} | {t,err}
const F = { q: '', sort: 'order', brand: '', cheaper: false, onlyWish: false, tags: [], match: 'any' };
const D = { min: 0, batch: 250 };   // top deals

const wish = new Set(load('bf.wish', []));
const saveWish = () => { save('bf.wish', [...wish]); badges(); };
let cmp = load('bf.cmp', []).slice(0, 4);
const saveCmp = () => { save('bf.cmp', cmp); badges(); dock(); };

/* What eMag answered is kept, so paging back and forth does not ask twice and a reload does not
   start from nothing. Only the most recent few thousand are written back: the whole catalog would
   not fit in localStorage, and the oldest are the ones worth asking again anyway. */
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

/* ---------------------------------------------------------------- asking eMag */
const searchQuery = it => it.name.replace(/["'„”()]/g, ' ')
  .split(/\s+/).filter(Boolean).slice(0, 10).join(' ').slice(0, 90);
const searchURL = it => 'https://www.emag.ro/search/' + encodeURIComponent(searchQuery(it));
const linkFor = it => (emag.get(it.id) || {}).url || searchURL(it);

let READER = null;   // null until probed, then true (a reader on this origin) or false
async function findReader() {
  try {
    const r = await fetch('emag/ping', { cache: 'no-store' });
    READER = r.ok && (await r.text()).trim() === 'ok';
  } catch (e) { READER = false; }
}
async function get(url) {
  const r = await fetch(READER ? 'emag?u=' + encodeURIComponent(url) : url, { credentials: 'omit' });
  if (!r.ok) throw new Error(READER ? 'The reader answered ' + r.status : 'eMag answered ' + r.status);
  return r.text();
}

/* A few at a time. A page holds sixty cards and the observer can fire on a dozen at once, so
   without this a single scroll would open a dozen connections and eMag would start refusing. */
const waiting = [], busy = new Set();
function ask(it) {
  if (emag.has(it.id) || waiting.includes(it)) return;   // asked once; every card has a retry button
  waiting.push(it);
  pump();
}
function pump() {
  while (busy.size < Math.max(1, SET.parallel) && waiting.length) {
    const it = waiting.shift();
    busy.add(it.id);
    emag.set(it.id, { busy: true });
    paint(it);
    look(it).finally(() => {
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
async function look(it) {
  try {
    const hits = parseSearch(await get(searchURL(it)));
    if (!hits.length) throw new Error('Nothing on eMag under this name');
    emag.set(it.id, Object.assign({ t: Date.now() }, closest(it, hits)));
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
/* Asking for a batch on purpose: the top deals page and the liked page both do it. */
function askMany(items, max) {
  const todo = items.filter(it => !emag.has(it.id)).slice(0, max);
  todo.forEach(ask);
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
/* Re-draw whichever view is open, once the answers stop arriving in a rush. */
/* While a batch is running, answers land every few hundred milliseconds. A plain debounce would sit
   waiting for a gap that never comes, so the open page is redrawn on a leash instead: straight away,
   then at most once every 1.2s, and once more when the traffic stops. */
let bumpAt = 0, bumpT = null;
function bump() {
  if (VIEW === 'catalog') return;
  clearTimeout(bumpT);
  bumpT = setTimeout(() => { bumpAt = Date.now(); draw[VIEW](); }, Math.max(0, 1200 - (Date.now() - bumpAt)));
}

/* eMag cannot be asked for a product by title, so the search results are all there is to go on: a
   result whose name is ours wins outright, otherwise the best token overlap, with eMag's own
   ranking breaking a tie. Model numbers count for most -- they are what identifies the thing. */
function closest(it, hits) {
  const want = norm(it.name);
  const exact = hits.find(h => {
    const t = norm(h.title);
    return t === want || (want.length > 25 && (t.startsWith(want) || want.startsWith(t)));
  });
  if (exact) return Object.assign({ score: 1 }, exact);
  let best = null;
  hits.slice(0, 12).forEach((h, i) => {
    const s = score(it.name, h.title) - i * 0.01;
    if (!best || s > best.score) best = Object.assign({ score: +s.toFixed(2) }, h);
  });
  return best;
}
const tok = s => norm(s).split(/[^a-z0-9]+/).filter(t => t.length > 1);
function score(mine, theirs2) {
  const them = new Set(tok(theirs2));
  let got = 0, tot = 0;
  for (const t of tok(mine).slice(0, 14)) {
    const w = /\d/.test(t) && /[a-z]/.test(t) ? 4 : /\d/.test(t) ? 1.5 : 1;
    tot += w;
    if (them.has(t)) got += w;
  }
  return tot ? got / tot : 0;
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
function filtered() {
  const qs = norm(F.q).split(/\s+/).filter(Boolean);
  const brand = norm(F.brand.trim());
  const out = [];
  for (const it of ITEMS) {
    if (F.onlyWish && !wish.has(it.id)) continue;
    if (brand && norm(it.brand).indexOf(brand) < 0) continue;
    if (F.tags.length) {
      const has = F.tags.filter(t => it.tags.includes(t)).length;
      if (F.match === 'all' ? has !== F.tags.length : !has) continue;
    }
    if (qs.length) { const h = hay(it); if (!qs.every(x => h.indexOf(x) >= 0)) continue; }
    if (F.cheaper) { const d = diffOf(it); if (!d || d.d <= 0) continue; }
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
    priceAsc: num(i => i.price, 1),
    priceDesc: num(i => i.price, -1),
    saveDesc: num(i => (diffOf(i) || {}).d, -1),
    savePctDesc: num(i => (diffOf(i) || {}).p, -1),
    nameAsc: (a, b) => a.name.localeCompare(b.name, 'ro'),
  }[F.sort];
  if (by) out.sort(by);
  return out;
}
const anyFilter = () => !!(F.q.trim() || F.brand.trim() || F.tags.length || F.cheaper || F.onlyWish);

/* ---------------------------------------------------------------- bits of markup */
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.3C1.1 8.3 3.3 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.7 0 5.9 3.8 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';
const AGAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.5 11a8.5 8.5 0 1 0-2.6 6.1M20.5 4.5V11h-6.5"/></svg>';
const SCALE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12 3v18M7 21h10M3 8h18M6 8l-3 6h6zM18 8l-3 6h6z"/></svg>';

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

/* ---------------------------------------------------------------- the catalog */
function card(it) {
  const r = emag.get(it.id) || {};
  const d = diffOf(it);
  const weak = r.score != null && r.score < 0.45;
  return '<article class="card" data-id="' + it.id + '">'
    + '<div class="pic">' + pic(r) + sticker(d) + '</div>'
    + '<div class="body">'
    + '<p class="brand">' + esc(it.brand || '—') + '</p>'
    + '<h3 title="' + esc(it.name) + '">' + esc(nice(it.name)) + '</h3>'
    + '<p class="match' + (weak ? ' weak' : '') + '">' + (r.title ? (weak ? 'closest match: ' : '') + esc(r.title) : '') + '</p>'
    + '<div class="prices">'
    + '<span><small>my list</small>' + lei(it.price) + '</span>'
    + '<span><small>eMag</small>' + theirs(it) + '</span>'
    + '</div></div>'
    + '<div class="acts">'
    + '<button class="ico' + (wish.has(it.id) ? ' on' : '') + '" data-act="wish" type="button" title="Like this one" aria-label="Like this one">' + HEART + '</button>'
    + '<button class="ico' + (inCmp(it) ? ' on' : '') + '" data-act="cmp" type="button" title="Add to compare" aria-label="Add to compare">' + SCALE + '</button>'
    + '<button class="ico" data-act="again" type="button" title="Ask eMag again" aria-label="Ask eMag again">' + AGAIN + '</button>'
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
function renderTags() {
  $('#tagRail').innerHTML = TAGS.map(t =>
    '<button class="chip' + (F.tags.includes(t.name) ? ' on' : '') + '" data-tag="' + esc(t.name) + '" type="button">'
    + esc(t.name.replace(/-/g, ' ')) + '<small>' + ro(t.n) + '</small></button>').join('');
  $('#nTags').textContent = F.tags.length ? F.tags.length : '';
  $$('#tagBox [data-match]').forEach(b => {
    const on = b.dataset.match === F.match;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
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
      + '<div class="body"><p class="brand">' + esc(x.it.brand || '—') + '</p>'
      + '<h3 title="' + esc(x.it.name) + '">' + esc(nice(x.it.name)) + '</h3>'
      + '<div class="prices"><span><small>my list</small>' + lei(x.it.price) + '</span>'
      + '<span><small>eMag</small><strong>' + lei(r.price) + '</strong></span></div></div>'
      + '<div class="acts">'
      + '<button class="ico' + (wish.has(x.it.id) ? ' on' : '') + '" data-act="wish" type="button" aria-label="Like this one">' + HEART + '</button>'
      + '<button class="ico' + (inCmp(x.it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '<a href="' + esc(linkFor(x.it)) + '" target="_blank" rel="noopener noreferrer">Open in eMag</a>'
      + '</div></article>';
  }).join('');

  const list = rest.map((x, i) => {
    const r = emag.get(x.it.id);
    return '<div class="row-item" data-id="' + x.it.id + '">'
      + '<span class="rank sm">' + (i + 4) + '</span>'
      + '<div class="thumb">' + pic(r) + '</div>'
      + '<div class="rmain"><p class="t" data-act="emag" title="' + esc(x.it.name) + '">' + esc(nice(x.it.name)) + '</p>'
      + '<p class="brand">' + esc(x.it.brand || '—') + ' · ' + sectionList(x.it) + '</p></div>'
      + '<div class="rp"><strong>' + lei(x.it.price) + '</strong><small>eMag ' + lei(r.price) + '</small></div>'
      + '<div class="rd">' + sticker(x.d) + '</div>'
      + '<div class="ract">'
      + '<button class="ico' + (wish.has(x.it.id) ? ' on' : '') + '" data-act="wish" type="button" aria-label="Like this one">' + HEART + '</button>'
      + '<button class="ico' + (inCmp(x.it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '</div></div>';
  }).join('');

  v.innerHTML = '<div class="page-head"><div><h2>Top deals</h2>'
    + '<p class="note-in">Where the list beats eMag by the widest margin, out of the '
    + ro(pool.length - unknown) + ' of ' + ro(pool.length) + ' products checked so far'
    + (anyFilter() ? ' in the current filter' : '') + '. '
    + (unknown ? 'Checking more widens the search.' : 'Everything here has been checked.') + '</p></div>'
    + '<div class="headtools">'
    + '<label class="inline">At least <select id="dMin">'
    + [0, 5, 10, 20, 30, 50].map(p => '<option value="' + p + '"' + (D.min === p ? ' selected' : '') + '>' + (p ? p + '%' : 'any') + '</option>').join('')
    + '</select> cheaper</label>'
    + (unknown ? '<button class="btn" id="dScan" type="button">Check ' + ro(Math.min(unknown, D.batch)) + ' more</button>' : '')
    + '<button class="ghost" data-stop type="button" hidden>Stop</button>'
    + '<span class="prog" data-prog></span>'
    + '</div></div>'
    + (rows.length
      ? '<div class="podium">' + podium + '</div>' + (rest.length ? '<div class="rows">' + list + '</div>' : '')
      : '<div class="box">Nothing beats eMag here yet'
        + (D.min ? ', by ' + D.min + '% or more' : '') + '. '
        + (unknown ? 'Check some more and they will appear.' : 'Try a smaller margin, or widen the filter.')
        + '</div>')
    + (rows.length > 60 ? '<p class="foot">Showing the best 60 of ' + ro(rows.length) + '.</p>' : '');

  const mn = $('#dMin', v);
  if (mn) mn.onchange = e => { D.min = +e.target.value; renderDeals(); };
  const sc = $('#dScan', v);
  if (sc) sc.onclick = () => {
    const n = askMany(pool, D.batch);
    toast(n ? 'Checking ' + ro(n) + ' products on eMag…' : 'Nothing left to check here');
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
      + '<p class="brand">' + esc(it.brand || '—') + ' · ' + sectionList(it) + '</p></div>'
      + '<div class="rp"><strong>' + lei(it.price) + '</strong><small>eMag ' + (r.price != null ? lei(r.price) : '—') + '</small></div>'
      + '<div class="rd">' + (d ? sticker(d) : '<span class="na">' + (r.busy ? 'asking…' : r.err ? 'no price' : 'not checked') + '</span>') + '</div>'
      + '<div class="ract">'
      + '<button class="ico' + (inCmp(it) ? ' on' : '') + '" data-act="cmp" type="button" aria-label="Add to compare">' + SCALE + '</button>'
      + '<button class="ico on" data-act="wish" type="button" aria-label="Remove from liked">' + HEART + '</button>'
      + '</div></div>';
  }).join('');

  v.innerHTML = '<div class="page-head"><div><h2>Liked</h2>'
    + '<p class="note-in">' + (items.length ? ro(items.length) + ' products kept in this browser.' : 'Nothing liked yet.') + '</p></div>'
    + (items.length ? '<div class="headtools">'
      + '<button class="btn" id="lLoad" type="button"' + (T.missing ? '' : ' disabled') + '>Check ' + ro(T.missing) + ' on eMag</button>'
      + '<button class="ghost" data-stop type="button" hidden>Stop</button><span class="prog" data-prog></span>'
      + '</div>' : '')
    + '</div>'
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
        + '<div class="budget">'
        + '<form class="inline" id="bForm"><label for="bVal">Budget</label>'
        + '<input id="bVal" name="b" type="number" inputmode="decimal" min="0" step="any" value="' + (SET.budget == null ? '' : SET.budget) + '" placeholder="e.g. 5000">'
        + '<span class="note-in">lei</span><button class="ghost" type="submit">Set</button>'
        + (SET.budget ? '<button class="ghost" type="button" id="bClr">Remove</button>' : '') + '</form>'
        + (SET.budget ? '<div class="meter' + (over ? ' over' : '') + '"><span style="width:' + used + '%"></span></div>'
          + '<p class="note-in">' + (over ? 'Over by ' + lei(T.mine - SET.budget) : lei(SET.budget - T.mine) + ' left of ' + lei(SET.budget)) + '</p>' : '')
        + '</div>'
        + '<div class="rows">' + rows + '</div>'
        + '<div class="headtools end">'
        + '<button class="ghost" id="lShow" type="button">Show in the catalog</button>'
        + '<button class="ghost" id="lCmp" type="button">Compare the first four</button>'
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
  $('#lClr', v).onclick = () => {
    if (!confirm('Remove all ' + items.length + ' liked products?')) return;
    wish.clear();
    saveWish();
    renderLiked();
  };
  progress();
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
    v.innerHTML = '<div class="page-head"><div><h2>Compare</h2></div></div>'
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
  const ep = items.map(i => { const r = emag.get(i.id); return r && r.price != null ? r.price : null; });
  const ds = items.map(diffOf);
  add('My list price', lp.map(x => '<span class="num">' + lei(x) + '</span>'), win(lp, 'min'));
  add('eMag price', items.map(theirs), win(ep, 'min'));
  add('Saving vs eMag', ds.map(d => d ? sticker(d) : '—'), win(ds.map(d => d ? d.d : null), 'max'));
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

  v.innerHTML = '<div class="page-head"><div><h2>Compare</h2>'
    + '<p class="note-in">Lowest price and biggest saving are marked. The specification rows are read out of the product name.</p></div>'
    + '<div class="headtools">'
    + (missing.length ? '<button class="btn" id="cLoad" type="button">Check ' + missing.length + ' on eMag</button>' : '')
    + '<button class="ghost" id="cCsv" type="button">Download CSV</button>'
    + '<button class="ghost danger" id="cClr" type="button">Clear</button>'
    + '</div></div>'
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
  const cl = $('#cLoad', v);
  if (cl) cl.onclick = () => { askMany(items, 4); toast('Checking eMag…'); };
}

/* ---------------------------------------------------------------- settings */
const srcLine = () => READER
  ? 'This copy has its own reader on the server, so eMag prices load by themselves. Nothing to install.'
  : 'There is no reader on this address, so every request goes straight to emag.ro from your browser'
    + ' — which only gets through with the userscript installed.';

function renderSettings() {
  const v = $('#view-settings');
  const checked = [...emag.values()].filter(r => r.t).length;
  const priced = [...emag.values()].filter(r => r.price != null).length;
  v.innerHTML = '<div class="page-head"><div><h2>Settings</h2></div></div><div class="panels">'

    + '<div class="panel"><h3>Where eMag prices come from</h3>'
    + '<p class="' + (READER ? 'ok' : 'warnline') + '">' + esc(srcLine()) + '</p>'
    + '<p class="note-in">A page is not allowed to read emag.ro: the browser makes the request and then '
    + 'refuses to hand the reply to a script from another origin. A server is under no such rule, which '
    + 'is why the self-hosted copy needs nothing installed &mdash; it asks its own reader at '
    + '<code>/emag</code>. On GitHub Pages there is no reader, so '
    + '<a href="tools/emaglist.user.js">tools/emaglist.user.js</a> in Tampermonkey or Violentmonkey has '
    + 'to make the request instead.</p>'
    + '<div class="inline"><button class="btn" id="sTest" type="button">Test the connection</button>'
    + '<span class="note-in" id="sOut"></span></div></div>'

    + '<div class="panel"><h3>Loading</h3>'
    + '<label class="check wide"><input type="checkbox" id="sAuto"' + (SET.autoLoad ? ' checked' : '') + '> '
    + 'Ask eMag as cards reach the screen</label>'
    + '<p class="note-in">With this off nothing is fetched until you press a card&rsquo;s retry button, or one '
    + 'of the check buttons on the other pages.</p>'
    + '<div class="inline"><label for="sPar">At once</label>'
    + '<input id="sPar" type="number" min="1" max="6" value="' + SET.parallel + '">'
    + '<label for="sKeep">Reuse an answer for</label>'
    + '<input id="sKeep" type="number" min="1" max="720" value="' + SET.keepHours + '"><span class="note-in">hours</span></div>'
    + '<p class="note-in">More at once is faster, until eMag starts refusing; three is a safe pace.</p></div>'

    + '<div class="panel"><h3>Saved eMag data</h3>'
    + '<p>' + ro(checked) + ' products checked, ' + ro(priced) + ' of them with a price. Kept in this browser '
    + 'only, never sent anywhere.</p>'
    + '<div class="inline"><button class="ghost" id="sCsvAll" type="button">Download everything checked as CSV</button>'
    + '<button class="ghost danger" id="sWipe" type="button">Forget the saved prices</button></div></div>'

    + '<div class="panel"><h3>Backup</h3>'
    + '<p>Liked products, the compare picks, the budget, these settings and the saved eMag prices all live in '
    + 'this browser. A backup moves them to another one.</p>'
    + '<div class="inline"><button class="ghost" id="sExp" type="button">Download a backup</button>'
    + '<label class="ghost asbtn" for="sImp">Restore from a backup</label>'
    + '<input id="sImp" type="file" accept="application/json" hidden></div></div>'

    + '<div class="panel"><h3>Appearance</h3>'
    + '<div class="inline"><label for="sTheme">Theme</label><select id="sTheme">'
    + [['system', 'Match the device'], ['light', 'Light'], ['dark', 'Dark']].map(o =>
      '<option value="' + o[0] + '"' + (SET.theme === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('')
    + '</select></div></div>'

    + '</div>';

  $('#sAuto', v).onchange = e => { SET.autoLoad = e.target.checked; saveSet(); };
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
  $('#sCsvAll', v).onclick = () => csv(ITEMS.filter(it => emag.has(it.id)), 'checked');
  $('#sWipe', v).onclick = () => {
    if (!confirm('Forget every saved eMag price and picture?')) return;
    emag.clear();
    save(STORE, {});
    toast('Saved eMag data forgotten');
    renderSettings();
  };
  $('#sExp', v).onclick = () => {
    const blob = new Blob([JSON.stringify({
      app: 'bfemag', v: 2, at: new Date().toISOString(),
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
  const head = ['nr', 'name', 'brand', 'sections', 'list price', 'eMag price', 'eMag old price',
    'difference', 'difference %', 'matched name', 'match confidence', 'eMag link'];
  const body = items.map(it => {
    const r = emag.get(it.id) || {}, d = diffOf(it);
    return [it.id, it.name, it.brand, it.tags.join(' '), it.price,
      r.price == null ? '' : r.price, r.old == null ? '' : r.old,
      d ? d.d.toFixed(2) : '', d ? d.p.toFixed(1) : '', r.title || '',
      r.score == null ? '' : Math.round(r.score * 100), r.url || ''].map(q).join(',');
  });
  const blob = new Blob(['﻿' + [head.map(q).join(','), ...body].join('\r\n')],
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
}

/* One click handler for every list on every page: the cards, the deal rows, the liked rows. */
function actOn(e) {
  const host = e.target.closest('[data-id]');
  const hit = e.target.closest('[data-act]');
  if (!host || !hit) return;
  const it = byId.get(+host.dataset.id);
  if (!it) return;
  const act = hit.dataset.act;
  if (act === 'wish') {
    if (wish.has(it.id)) wish.delete(it.id); else wish.add(it.id);
    saveWish();
    if (VIEW === 'catalog') paint(it); else draw[VIEW]();
  }
  if (act === 'cmp') {
    toggleCmp(it);
    if (VIEW === 'catalog') paint(it); else draw[VIEW]();
  }
  if (act === 'again') { emag.delete(it.id); ask(it); }
  if (act === 'emag') window.open(linkFor(it), '_blank', 'noopener');
}

/* ---------------------------------------------------------------- the router */
const draw = {
  catalog: () => renderCatalog(true),
  deals: renderDeals,
  liked: renderLiked,
  compare: renderCompare,
  settings: renderSettings,
};
function route() {
  const want = (location.hash.replace(/^#\/?/, '') || 'catalog').split('?')[0];
  VIEW = draw[want] ? want : 'catalog';
  $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + VIEW; });
  $$('.views a').forEach(a => {
    const on = a.dataset.view === VIEW;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  /* Liked, compare and settings pay no attention to the search bar, so it is put away there rather
     than left on screen doing nothing. The header count still follows the filters, which is why the
     other pages refresh it before they draw. */
  $('#bar').hidden = VIEW === 'settings' || VIEW === 'compare' || VIEW === 'liked';
  if (VIEW !== 'catalog') { RESULTS = filtered(); tally(); }
  dock();
  draw[VIEW]();
  window.scrollTo({ top: 0 });
}

/* ---------------------------------------------------------------- wiring */
function wire() {
  const redraw = debounce(() => { page = 0; draw[VIEW](); }, 220);
  $('#q').addEventListener('input', e => { F.q = e.target.value; redraw(); });
  $('#brand').addEventListener('input', e => { F.brand = e.target.value; redraw(); });
  $('#sort').onchange = e => { F.sort = e.target.value; page = 0; draw[VIEW](); };
  $('#cheaper').onchange = e => { F.cheaper = e.target.checked; page = 0; draw[VIEW](); };
  $('#onlyWish').onchange = e => { F.onlyWish = e.target.checked; page = 0; draw[VIEW](); };
  $('#reset').onclick = () => {
    Object.assign(F, { q: '', sort: 'order', brand: '', cheaper: false, onlyWish: false, tags: [], match: 'any' });
    $('#q').value = '';
    $('#brand').value = '';
    $('#sort').value = 'order';
    $('#cheaper').checked = false;
    $('#onlyWish').checked = false;
    renderTags();
    page = 0;
    draw[VIEW]();
  };
  $('#tagsOpen').onclick = e => {
    const box = $('#tagBox');
    box.hidden = !box.hidden;
    e.currentTarget.setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
  };
  $('#tagRail').onclick = e => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag;
    F.tags = F.tags.includes(t) ? F.tags.filter(x => x !== t) : [...F.tags, t];
    renderTags();
    page = 0;
    draw[VIEW]();
  };
  $$('#tagBox [data-match]').forEach(b => b.onclick = () => {
    F.match = b.dataset.match;
    renderTags();
    page = 0;
    draw[VIEW]();
  });
  $('#pager').onclick = e => {
    const b = e.target.closest('[data-go]');
    if (!b || b.disabled) return;
    page = +b.dataset.go;
    renderCatalog();
  };
  $('main').onclick = actOn;
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

    const n = new Map();
    for (const it of ITEMS) for (const t of it.tags) n.set(t, (n.get(t) || 0) + 1);
    TAGS = [...n].map(e => ({ name: e[0], n: e[1] })).sort((a, b) => b.n - a.n);

    $('#brands').innerHTML = j.brands.map(b => '<option value="' + esc(b) + '">').join('');
    $('#srcFoot').textContent = srcLine();
    loadStore();
    badges();
    renderTags();
    wire();
    $('#loading').remove();
    route();
  } catch (e) {
    $('#loading').innerHTML = '<p class="bad">Could not load the product list: ' + esc(e.message) + '</p>';
  }
})();
