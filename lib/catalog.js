'use strict';
/* The list itself, held in memory once and asked questions over HTTP.

   products.json is the same file the page downloads, so the two never disagree. Having it here as
   well buys three things the page cannot do on its own: a filter that runs over all 34,083 rows
   instead of the ones a browser happens to have, section counts that already know what else is
   ticked, and sorting by saving across every eMag price the database has ever seen. */

const fs = require('fs');
const path = require('path');
const store = require('./store');

const FILE = process.env.CATALOG
  || [path.join(__dirname, '..', 'site', 'products.json'), path.join(__dirname, '..', 'products.json')]
    .find(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } });

const norm = s => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

let TAGS = [], BRANDS = [], ITEMS = [], BY_ID = new Map(), SOURCE = '';

function boot() {
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  TAGS = raw.tags || [];
  BRANDS = raw.brands || [];
  SOURCE = raw.source || '';
  ITEMS = (raw.items || []).map(r => ({
    id: r[0],
    name: r[1] == null ? '' : String(r[1]),
    price: r[2] == null ? null : +r[2],
    brand: r[3] == null ? '' : (BRANDS[r[3]] || ''),
    tags: (r[4] || []).map(i => TAGS[i]).filter(Boolean),
    hay: '',
  }));
  for (const it of ITEMS) {
    it.hay = norm(it.name + ' ' + it.brand + ' ' + it.tags.join(' '));
    BY_ID.set(String(it.id), it);
  }
  return ITEMS.length;
}
boot();

const byId = id => BY_ID.get(String(id)) || null;

/* What the page sees for one product: the list row, plus whatever the database knows. */
function dress(it, picks) {
  const row = store.getRow(String(it.id));
  const p = picks && picks[String(it.id)];
  const out = {
    id: it.id, name: it.name, price: it.price, brand: it.brand, tags: it.tags,
    emag: row ? {
      price: row.price, old: row.old, img: row.img, url: row.url, title: row.title,
      score: row.score, t: row.t, low: row.low, hist: row.hist || [],
    } : null,
  };
  if (p) out.pick = p;
  if (row && row.price != null && it.price != null) {
    out.save = +(row.price - it.price).toFixed(2);
    out.savePct = row.price ? +((out.save / row.price) * 100).toFixed(1) : 0;
  }
  return out;
}

const SORTS = {
  order: (a, b) => a.id - b.id,
  orderDesc: (a, b) => b.id - a.id,
  nameAsc: (a, b) => a.name.localeCompare(b.name, 'ro'),
  nameDesc: (a, b) => b.name.localeCompare(a.name, 'ro'),
  brandAsc: (a, b) => (a.brand || '￿').localeCompare(b.brand || '￿', 'ro') || a.id - b.id,
  priceAsc: (a, b) => (a.price == null) - (b.price == null) || a.price - b.price,
  priceDesc: (a, b) => (a.price == null) - (b.price == null) || b.price - a.price,
  emagAsc: (a, b) => nn(ep(a)) - nn(ep(b)),
  emagDesc: (a, b) => nn(ep(b), -1) - nn(ep(a), -1),
  saveDesc: (a, b) => nn(sv(b), -1) - nn(sv(a), -1),
  saveAsc: (a, b) => nn(sv(a)) - nn(sv(b)),
  savePctDesc: (a, b) => nn(pc(b), -1) - nn(pc(a), -1),
  freshDesc: (a, b) => nn(tm(b), -1) - nn(tm(a), -1),
};
const nn = (v, miss) => (v == null ? (miss === -1 ? -Infinity : Infinity) : v);
const row = it => store.getRow(String(it.id));
const ep = it => { const r = row(it); return r && r.price != null ? r.price : null; };
const sv = it => { const r = row(it); return r && r.price != null && it.price != null ? r.price - it.price : null; };
const pc = it => { const r = row(it); return r && r.price && it.price != null ? ((r.price - it.price) / r.price) * 100 : null; };
const tm = it => { const r = row(it); return r ? r.t : null; };

/* ---- the query ----------------------------------------------------------------------------- */

function query(q, picks) {
  const want = norm(q.q || '').split(/\s+/).filter(Boolean);
  const brand = norm(q.brand || '');
  const tags = String(q.tags || '').split(',').map(s => s.trim()).filter(Boolean);
  const all = q.match === 'all';
  const min = q.min === '' || q.min == null ? null : +q.min;
  const max = q.max === '' || q.max == null ? null : +q.max;
  const minPct = q.minPct ? +q.minPct : 0;
  const minSave = q.minSave ? +q.minSave : 0;
  const state = q.state || '';           // priced | unpriced | cheaper | dearer | nolist
  const stock = q.pick || '';            // picked | bought | unbought
  const ids = q.ids ? String(q.ids).split(',').map(s => s.trim()).filter(Boolean) : null;

  const kept = [];
  const tagCount = Object.create(null);

  for (const it of ITEMS) {
    if (ids && !ids.includes(String(it.id))) continue;
    if (want.length && !want.every(w => it.hay.includes(w))) continue;
    if (brand && !norm(it.brand).includes(brand)) continue;
    if (min != null && !(it.price != null && it.price >= min)) continue;
    if (max != null && !(it.price != null && it.price <= max)) continue;

    if (tags.length) {
      const has = all ? tags.every(t => it.tags.includes(t)) : tags.some(t => it.tags.includes(t));
      if (!has) continue;
    }

    const r = row(it);
    if (state === 'priced' && !(r && r.price != null)) continue;
    if (state === 'unpriced' && r && r.price != null) continue;
    if (state === 'nolist' && it.price != null) continue;
    if (state === 'cheaper' && !(r && r.price != null && it.price != null && it.price < r.price)) continue;
    if (state === 'dearer' && !(r && r.price != null && it.price != null && it.price > r.price)) continue;

    if (minSave || minPct) {
      const s = sv(it), p = pc(it);
      if (s == null) continue;
      if (minSave && s < minSave) continue;
      if (minPct && (p == null || p < minPct)) continue;
    }

    if (stock) {
      const p = picks && picks[String(it.id)];
      if (stock === 'picked' && !p) continue;
      if (stock === 'bought' && !(p && p.bought)) continue;
      if (stock === 'unbought' && !(p && !p.bought)) continue;
    }

    kept.push(it);
    /* Section counts are taken after everything else has been applied, so with "all of them" on
       they say how many are left if you tick one more -- which is what makes the rail prune itself. */
    for (const t of it.tags) tagCount[t] = (tagCount[t] || 0) + 1;
  }

  const sort = SORTS[q.sort] ? q.sort : 'order';
  kept.sort(SORTS[sort]);

  const per = Math.min(240, Math.max(1, +q.per || 60));
  const page = Math.max(0, +q.page || 0);
  const slice = kept.slice(page * per, page * per + per);

  /* Totals over the whole result, not just the page on screen. */
  let listSum = 0, emagSum = 0, priced = 0;
  for (const it of kept) {
    if (it.price != null) listSum += it.price;
    const r = row(it);
    if (r && r.price != null) { emagSum += r.price; priced++; }
  }

  return {
    total: kept.length,
    page, per, sort,
    pages: Math.ceil(kept.length / per),
    priced,
    listSum: +listSum.toFixed(2),
    emagSum: +emagSum.toFixed(2),
    items: slice.map(it => dress(it, picks)),
    tagCount,
  };
}

const info = () => ({
  count: ITEMS.length, tags: TAGS, brands: BRANDS, source: SOURCE, file: FILE, sorts: Object.keys(SORTS),
});

module.exports = { query, byId, info, items: () => ITEMS, dress };
