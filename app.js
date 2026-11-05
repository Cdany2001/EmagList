/* BF list vs eMag.

   One hardcoded product list, shown a page at a time. A card asks eMag for its own price when it
   comes near the viewport, and never before: search by title, keep the closest-named result, show
   that price and picture. That is the whole app -- no proxy, no helper server, no chunked catalog,
   no cache of its own beyond what the browser already keeps.

   A page served from github.io cannot read emag.ro by itself: the browser makes the request but
   will not hand the reply to a script from another origin, and eMag sends nothing that waives
   that. tools/emaglist.user.js is what lets this browser allow it. Without it every card says so
   in place of a price. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nf = new Intl.NumberFormat('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ro = n => n.toLocaleString('ro-RO');
const lei = v => v == null || isNaN(v) ? '—' : nf.format(v) + ' lei';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

/* ---------------------------------------------------------------- state */
const PER = 60;
let ITEMS = [], RESULTS = [], page = 0;
const byId = new Map();
const emag = new Map();   // id -> {busy:true} | {t,price,img,url,title,old,score} | {t,err}
const F = { q: '', sort: 'order', brand: '', cheaper: false, onlyWish: false };

const wish = new Set(load('bf.wish', []));
const saveWish = () => save('bf.wish', [...wish]);

/* What eMag answered is kept for a day, so paging back and forth does not ask twice and a reload
   does not start from nothing. Only the most recent few thousand are written back: the whole
   catalog would not fit in localStorage, and the oldest are the ones worth asking again anyway. */
const STORE = 'bf.emag', DAY = 864e5;
function loadStore() {
  const o = load(STORE, {});
  for (const id in o) if (o[id].t && Date.now() - o[id].t < DAY) emag.set(+id, o[id]);
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

// the only request this app makes to eMag
async function get(url) {
  const r = await fetch(url, { credentials: 'omit' });
  if (!r.ok) throw new Error('eMag answered ' + r.status);
  return r.text();
}

/* Three at a time. A page holds sixty cards and the observer can fire on a dozen at once, so
   without this a single scroll would open a dozen connections and eMag would start refusing. */
const waiting = [], busy = new Set();
function ask(it) {
  if (emag.has(it.id) || waiting.includes(it)) return;   // asked once; the card has a button to retry
  waiting.push(it);
  pump();
}
function pump() {
  while (busy.size < 3 && waiting.length) {
    const it = waiting.shift();
    busy.add(it.id);
    emag.set(it.id, { busy: true });
    paint(it);
    look(it).finally(() => { busy.delete(it.id); paint(it); saveStore(); tally(); pump(); });
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
/* "Failed to fetch" is all the browser will say when it refuses to hand over a cross-origin
   reply, and it is the one failure a reader can do something about, so name it. */
function why(e) {
  const m = String(e && e.message || e);
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(m)) {
    $('#blocked').hidden = false;   // the footer explains the fix; nobody scrolls past 60 cards to find it
    return 'The browser would not let this page read eMag';
  }
  return m.slice(0, 140);
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
function score(mine, theirs) {
  const them = new Set(tok(theirs));
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
    if (it) ask(it);
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
  const cmp = {
    priceAsc: num(i => i.price, 1),
    priceDesc: num(i => i.price, -1),
    saveDesc: num(i => (diffOf(i) || {}).d, -1),
    savePctDesc: num(i => (diffOf(i) || {}).p, -1),
    nameAsc: (a, b) => a.name.localeCompare(b.name, 'ro'),
  }[F.sort];
  if (cmp) out.sort(cmp);
  return out;
}

/* ---------------------------------------------------------------- drawing */
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.3C1.1 8.3 3.3 4.5 7 4.5c2.1 0 3.6 1.2 5 3 1.4-1.8 2.9-3 5-3 3.7 0 5.9 3.8 4.5 7.2C19.5 16.4 12 21 12 21z"/></svg>';
const AGAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20.5 11a8.5 8.5 0 1 0-2.6 6.1M20.5 4.5V11h-6.5"/></svg>';

function card(it) {
  const r = emag.get(it.id) || {};
  const d = diffOf(it);
  const weak = r.score != null && r.score < 0.45;
  let theirs;
  if (r.busy) theirs = '<span class="na">Asking eMag…</span>';
  else if (r.err) theirs = '<span class="na err" title="' + esc(r.err) + '">' + esc(r.err) + '</span>';
  else if (r.price != null) theirs = '<strong>' + lei(r.price) + '</strong>' + (r.old ? ' <s>' + lei(r.old) + '</s>' : '');
  else if (r.t) theirs = '<span class="na">No price on the eMag page</span>';
  else theirs = '<span class="na">—</span>';

  const sticker = d
    ? '<span class="tag ' + (d.d > 0 ? 'win' : 'lose') + '">' + (d.d > 0 ? '−' : '+')
      + Math.abs(d.p).toFixed(0) + '%<small>' + (d.d > 0 ? 'save ' : 'eMag +') + lei(Math.abs(d.d)) + '</small></span>'
    : '';
  const name = !it.name || it.name === '0' ? '(no name in the source list)' : it.name;

  return '<article class="card" data-id="' + it.id + '">'
    + '<div class="pic">'
    + (r.img ? '<img src="' + esc(r.img) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
             : '<div class="ph' + (r.busy ? ' busy' : '') + '"></div>')
    + sticker
    + '</div>'
    + '<div class="body">'
    + '<p class="brand">' + esc(it.brand || '—') + '</p>'
    + '<h3 title="' + esc(it.name) + '">' + esc(name) + '</h3>'
    + '<p class="match' + (weak ? ' weak' : '') + '">' + (r.title ? (weak ? 'closest match: ' : '') + esc(r.title) : '') + '</p>'
    + '<div class="prices">'
    + '<span><small>my list</small>' + lei(it.price) + '</span>'
    + '<span><small>eMag</small>' + theirs + '</span>'
    + '</div></div>'
    + '<div class="acts">'
    + '<button class="ico' + (wish.has(it.id) ? ' on' : '') + '" data-act="wish" type="button" title="Keep this one" aria-label="Keep this one">' + HEART + '</button>'
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
function render(keepScroll) {
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

/* ---------------------------------------------------------------- wiring */
function wire() {
  const redraw = debounce(() => { page = 0; render(); }, 220);
  $('#q').addEventListener('input', e => { F.q = e.target.value; redraw(); });
  $('#brand').addEventListener('input', e => { F.brand = e.target.value; redraw(); });
  $('#sort').onchange = e => { F.sort = e.target.value; page = 0; render(); };
  $('#cheaper').onchange = e => { F.cheaper = e.target.checked; page = 0; render(); };
  $('#onlyWish').onchange = e => { F.onlyWish = e.target.checked; page = 0; render(); };
  $('#reset').onclick = () => {
    Object.assign(F, { q: '', sort: 'order', brand: '', cheaper: false, onlyWish: false });
    $('#q').value = '';
    $('#brand').value = '';
    $('#sort').value = 'order';
    $('#cheaper').checked = false;
    $('#onlyWish').checked = false;
    page = 0;
    render();
  };
  $('#pager').onclick = e => {
    const b = e.target.closest('[data-go]');
    if (!b || b.disabled) return;
    page = +b.dataset.go;
    render();
  };
  $('#grid').onclick = e => {
    const el = e.target.closest('.card');
    const hit = e.target.closest('[data-act]');
    if (!el || !hit) return;
    const it = byId.get(+el.dataset.id);
    if (!it) return;
    if (hit.dataset.act === 'wish') {
      if (wish.has(it.id)) wish.delete(it.id); else wish.add(it.id);
      saveWish();
      paint(it);
    }
    if (hit.dataset.act === 'again') { emag.delete(it.id); ask(it); }
  };
  $('#theme').onclick = () => {
    const dark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    save('bf.theme', document.documentElement.dataset.theme);
  };
}

/* ---------------------------------------------------------------- boot */
(async function boot() {
  const t = load('bf.theme', null);
  if (t) document.documentElement.dataset.theme = t;
  try {
    const r = await fetch('products.json');
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
    $('#brands').innerHTML = j.brands.map(b => '<option value="' + esc(b) + '">').join('');
    loadStore();
    wire();
    render();
    $('#loading').remove();
  } catch (e) {
    $('#loading').innerHTML = '<p class="bad">Could not load the product list: ' + esc(e.message) + '</p>';
  }
})();
