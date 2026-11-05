'use strict';
/* Reading eMag from the server, and working out which of its results is the product we meant.

   The page used to do all of this itself with DOMParser. Here there is no DOM, so the search page
   is picked apart with a handful of regexes over each product card -- enough for the four things
   worth keeping (name, link, picture, price) and nothing more. The matching rules are the same
   ones the page used, kept deliberately identical so a row read here and a row read there agree. */

const store = require('./store');

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

const norm = s => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
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

function closest(name, hits) {
  const want = norm(name);
  const exact = hits.find(h => {
    const t = norm(h.title);
    return t === want || (want.length > 25 && (t.startsWith(want) || want.startsWith(t)));
  });
  if (exact) return Object.assign({ score: 1 }, exact);
  let best = null;
  hits.slice(0, 12).forEach((h, i) => {
    const s = score(name, h.title) - i * 0.01;
    if (!best || s > best.score) best = Object.assign({ score: +s.toFixed(2) }, h);
  });
  return best;
}

const searchQuery = name => String(name).replace(/["'„”()]/g, ' ')
  .split(/\s+/).filter(Boolean).slice(0, 10).join(' ').slice(0, 90);
const searchURL = name => 'https://www.emag.ro/search/' + encodeURIComponent(searchQuery(name));

/* ---- the one call the rest of the server makes ---------------------------------------------- */

const waiting = new Map();   // id -> promise, so twenty cards asking at once make one request

function rowFor(item, force) {
  const id = String(item.id);
  if (!force) {
    const had = store.getRow(id);
    if (had) return Promise.resolve(had);
  }
  if (waiting.has(id)) return waiting.get(id);

  const job = fetchHtml(searchURL(item.name)).then(r => {
    if (r.status !== 200) {
      return { id, error: r.status === 502 ? 'eMag could not be reached' : 'eMag answered ' + r.status };
    }
    const hits = parseSearch(r.body);
    if (!hits.length) return { id, error: 'nothing on eMag matched that name' };
    const best = closest(item.name, hits);
    if (!best || best.price == null) return { id, error: 'no price on the closest result' };
    return store.putRow(id, {
      price: best.price, old: best.old, img: best.img, url: best.url,
      title: best.title, score: best.score, hits: hits.length,
    });
  }).catch(e => ({ id, error: String((e && e.message) || e) }))
    .then(v => { waiting.delete(id); return v; });

  waiting.set(id, job);
  return job;
}

const stats = () => ({ reads, fails, pages: pages.size, queue: queue.length, inflight });

module.exports = { fetchHtml, parseSearch, closest, score, rowFor, searchURL, stats };
