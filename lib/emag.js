'use strict';
/* Reading eMag from the server, and working out which of its results is the product we meant.

   The page used to do all of this itself with DOMParser. Here there is no DOM, so the search page
   is picked apart with a handful of regexes over each product card -- enough for the four things
   worth keeping (name, link, picture, price) and nothing more. Which result is the right one is
   not decided here at all: match.js decides it, and the page loads that same file, so a row read
   here and a row read in a browser agree by construction. */

const store = require('./store');
const M = require('../match.js');

const TTL = +(process.env.EMAG_TTL_MIN || 30) * 60e3;
const MAX_INFLIGHT = +(process.env.EMAG_CONCURRENCY || 3);
const GAP = +(process.env.EMAG_GAP_MS || 250);
const MAX_CACHED = 600;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

let reads = 0, fails = 0;

/* ---- the queue ----------------------------------------------------------------------------- */

const pages = new Map();   // url -> {t, status, body}
const queue = [];
let inflight = 0, lastStart = 0;

function fetchHtml(url) {
  const hit = pages.get(url);
  if (hit && Date.now() - hit.t < TTL) return Promise.resolve(Object.assign({ cached: true }, hit));
  return new Promise(resolve => { queue.push({ url, resolve }); pump(); });
}

function pump() {
  if (inflight >= MAX_INFLIGHT || !queue.length) return;
  const wait = Math.max(0, lastStart + GAP - Date.now());
  if (wait) return void setTimeout(pump, wait);

  const job = queue.shift();
  inflight++;
  lastStart = Date.now();

  const done = res => {
    inflight--;
    if (res.status === 200) {
      reads++;
      pages.set(job.url, res);
      if (pages.size > MAX_CACHED)
        for (const k of [...pages.keys()].slice(0, pages.size - MAX_CACHED)) pages.delete(k);
    } else fails++;
    job.resolve(res);
    pump();
  };

  fetch(job.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
    },
  })
    .then(r => r.text().then(body => done({ t: Date.now(), status: r.status, body })))
    .catch(e => done({ t: Date.now(), status: 502, body: 'eMag could not be reached: ' + e.message }));

  pump();
}

/* ---- pulling the cards apart --------------------------------------------------------------- */

const ENT = { quot: 0x22, amp: 0x26, lt: 0x3c, gt: 0x3e, apos: 0x27, nbsp: 0x20 };
const unesc = s => String(s || '')
  .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d))
  .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? String.fromCharCode(ENT[n.toLowerCase()]) : m));

const attr = (chunk, name) => {
  const m = chunk.match(new RegExp(name + '="([^"]*)"'));
  return m ? unesc(m[1]) : '';
};

const absUrl = u => !u ? null
  : u.indexOf('//') === 0 ? 'https:' + u
  : u.charAt(0) === '/' ? 'https://www.emag.ro' + u : u;

/* 547<sup><small>&#44;</small>12</sup> Lei -> 547.12. The entities go first: &#44; is full of
   digits and would otherwise be read as the bani. */
function fromPrice(frag) {
  if (!frag) return null;
  const sup = frag.match(/<sup[^>]*>([\s\S]*?)<\/sup>/);
  const head = frag.split('<sup')[0].replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, '');
  const ints = head.replace(/[^\d]/g, '');
  if (!ints) return null;
  const cents = sup
    ? sup[1].replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, '').replace(/\D/g, '').slice(0, 2)
    : '';
  return parseFloat(ints + '.' + (cents || '0'));
}

function parseSearch(html) {
  const out = [];
  const parts = String(html).split(/<div\s+class="card-item/i);
  for (let i = 1; i < parts.length; i++) {
    const c = parts[i].slice(0, 20000);
    const url = absUrl(attr(c, 'data-url'));
    if (!url || !/emag\.ro/.test(url)) continue;
    const title = attr(c, 'data-name').trim();
    if (!title) continue;

    /* the card's own JSON carries the price to the ban, which beats reading it off the markup */
    let price = null;
    const inJson = c.match(/&quot;price&quot;:\s*([\d.]+)/);
    if (inJson) price = parseFloat(inJson[1]);
    if (price == null) {
      const nw = c.match(/class="[^"]*product-new-price[^"]*"[^>]*>([\s\S]{0,200}?)<\/p>/);
      price = fromPrice(nw && nw[1]);
    }

    const od = c.match(/class="[^"]*product-old-price[^"]*"[^>]*>([\s\S]{0,200}?)<\/(?:p|div)>/)
      || c.match(/<s>([\s\S]{0,200}?)<\/s>/);
    let old = fromPrice(od && od[1]);
    if (!(old && price && old > price)) old = null;

    let img = null;
    const imgs = c.match(/<img[\s\S]{0,600}?>/g) || [];
    for (const tag of imgs) {
      const src = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original');
      if (src && src.indexOf('data:') !== 0 && /\/products\//.test(src)) { img = absUrl(src); break; }
    }

    out.push({ url: url.split('#')[0], title, img, price, old, pid: attr(c, 'data-product-id') || null });
  }
  return out;
}

/* ---- which result did we mean? ------------------------------------------------------------- */

/* match.js weighs a word by how rare it is across the whole list, so it needs the list counted
   once before it can judge anything. That costs about a seventh of a second over 34,083 names, and
   it is done on the first lookup rather than at boot: by then we are already waiting on eMag for
   something far longer. If the list cannot be read for any reason, every word simply weighs the
   same and the comparison still works, less sharply. */
function ready() {
  if (M.learned()) return;
  try { M.learn(require('./catalog').items().map(i => i.name)); }
  catch (e) { M.learn([]); }
}

/* ---- the one call the rest of the server makes ---------------------------------------------- */

const waiting = new Map();   // id -> promise, so twenty cards asking at once make one request

/* Two asks at most. The first is the ordinary one; the second goes out only when the first came
   back with nothing, or with nothing that looks like the thing, and carries just the brand and the
   model -- which is how the twenty-piece Tefal set and the Solarstrike 4 get found at all. When
   both tiers happen to word the same question, the page cache answers the second for free. */
async function lookUp(item) {
  ready();
  const brand = item.brand || '';
  let best = null, hits = 0, err = null;
  for (let tier = 0; tier < M.tiers; tier++) {
    const q = M.queryFor(item.name, tier, brand);
    if (!q) break;
    const r = await fetchHtml('https://www.emag.ro/search/' + encodeURIComponent(q));
    if (r.status !== 200) {
      err = r.status === 502 ? 'eMag could not be reached' : 'eMag answered ' + r.status;
      continue;
    }
    err = null;
    const found = parseSearch(r.body);
    if (found.length > hits) hits = found.length;
    const b = M.closest(item.name, found, { brand: brand });
    if (b && b.price != null && (!best || b.score > best.score)) best = b;
    if (best && best.score >= M.THIN) break;
  }
  const id = String(item.id);
  if (err) return { id: id, error: err };
  if (!hits) return { id: id, error: 'nothing on eMag matched that name' };
  if (!best) return { id: id, error: 'no price on the closest result' };
  return {
    price: best.price, old: best.old, img: best.img, url: best.url,
    title: best.title, score: best.score, hits: hits,
  };
}

function rowFor(item, force) {
  const id = String(item.id);
  if (!force) {
    const had = store.getRow(id);
    if (had) return Promise.resolve(had);
  }
  if (waiting.has(id)) return waiting.get(id);

  const job = lookUp(item).then(v => (v.error ? v : store.putRow(id, v)))
    .catch(e => ({ id, error: String((e && e.message) || e) }))
    .then(v => { waiting.delete(id); return v; });

  waiting.set(id, job);
  return job;
}

const stats = () => ({ reads, fails, pages: pages.size, queue: queue.length, inflight });

module.exports = {
  fetchHtml, parseSearch, rowFor, stats,
  closest: M.closest, score: M.score, searchURL: M.searchURL,
};
