/* The whole server: it hands out the static files, it reads eMag on the page's behalf, it keeps
   what it has read in a small database, and it runs the price watcher.

   A page cannot read emag.ro itself -- the browser fetches the reply and then refuses to hand it
   to a script from another origin. A server is under no such rule, so when the site is served from
   here the page asks this process instead and the answer arrives from its own origin. Once there
   is a server in the picture it may as well remember: an eMag price read for one visitor is a
   price every visitor already has, and nothing is asked of eMag twice.

   Node's standard library only: no package.json, no npm install, no dependencies to keep. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const store = require('./lib/store');
const catalog = require('./lib/catalog');
const emag = require('./lib/emag');
const watch = require('./lib/watch');

const PORT = +(process.env.PORT || 8080);
const SITE = path.resolve(process.env.SITE_DIR || path.join(__dirname, 'site'));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* Only eMag, and only over https. Without this the box would be an open proxy the moment its
   tunnel address leaked: anything on the internet could make it fetch anything, from inside
   whatever network it is running on. */
function allowed(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/(^|\.)emag\.ro$/i.test(u.hostname)) return null;
  return u.toString();
}

/* ---------------------------------------------------------------- answering */

function send(req, res, status, type, body, cacheFor, extra) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Object.assign({
    'Content-Type': type,
    'Cache-Control': cacheFor ? 'public, max-age=' + cacheFor : 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  }, extra || {});
  /* products.json is 3.6 MB of text and this may be going down a tunnel; gzip takes it under 900 KB */
  if (/text|json|javascript|svg/.test(type) && buf.length > 1024
      && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(buf, { level: 6 });
    head['Content-Encoding'] = 'gzip';
    head['Vary'] = 'Accept-Encoding';
    head['Content-Length'] = gz.length;
    res.writeHead(status, head);
    return void res.end(req.method === 'HEAD' ? undefined : gz);
  }
  head['Content-Length'] = buf.length;
  res.writeHead(status, head);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const json = (req, res, status, obj, extra) =>
  send(req, res, status, 'application/json; charset=utf-8', JSON.stringify(obj), 0, extra);

function body(req, cap) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > (cap || 64e3)) { reject(new Error('too much')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => {
      const s = Buffer.concat(parts).toString('utf8');
      if (!s) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error('that was not JSON')); }
    });
    req.on('error', reject);
  });
}

const cookies = req => {
  const out = {};
  for (const bit of String(req.headers.cookie || '').split(';')) {
    const i = bit.indexOf('=');
    if (i > 0) out[bit.slice(0, i).trim()] = decodeURIComponent(bit.slice(i + 1).trim());
  }
  return out;
};
const whoFrom = req => store.whoIs(cookies(req).bf);
const setCookie = token => ({
  'Set-Cookie': 'bf=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 30 * 86400,
});
const dropCookie = { 'Set-Cookie': 'bf=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' };

/* A sign-in page on a box with a public address gets knocked on. Ten tries per name per ten
   minutes is plenty for someone who owns the account and useless to anyone who does not. */
const tries = new Map();
function tooMany(name) {
  const now = Date.now();
  const t = (tries.get(name) || []).filter(x => now - x < 6e5);
  t.push(now);
  tries.set(name, t);
  return t.length > 10;
}

/* ---------------------------------------------------------------- the API */

const need = (res, req) => { json(req, res, 401, { error: 'Sign in first' }); return null; };

async function api(req, res, p, url) {
  const q = Object.fromEntries(url.searchParams);
  const me = whoFrom(req);

  if (p === '/api/hello') {
    const info = catalog.info();
    return json(req, res, 200, {
      backend: 1,
      catalog: { count: info.count, source: info.source, tags: info.tags.length, brands: info.brands.length },
      sorts: info.sorts,
      user: me,
      anyUser: store.anyUser(),
      store: store.health(),
      emag: emag.stats(),
      watcher: watch.state(),
    });
  }

  /* ---- accounts ---- */

  if (p === '/api/signup' && req.method === 'POST') {
    const b = await body(req);
    const err = store.addUser(b.user, b.pass);
    if (err) return json(req, res, 400, { error: err });
    const name = String(b.user).trim().toLowerCase();
    return json(req, res, 200, { user: name }, setCookie(store.openSession(name)));
  }

  if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.user || '').trim().toLowerCase();
    if (tooMany(name)) return json(req, res, 429, { error: 'Too many tries. Give it ten minutes.' });
    const ok = store.checkUser(name, b.pass);
    if (!ok) return json(req, res, 401, { error: 'Wrong username or password' });
    return json(req, res, 200, { user: ok }, setCookie(store.openSession(ok)));
  }

  if (p === '/api/logout' && req.method === 'POST') {
    store.closeSession(cookies(req).bf);
    return json(req, res, 200, { user: null }, dropCookie);
  }

  if (p === '/api/me') return json(req, res, 200, { user: me, anyUser: store.anyUser() });

  /* ---- the list ---- */

  if (p === '/api/items') {
    const picks = me ? store.budgetOf(me).picks : null;
    return json(req, res, 200, catalog.query(q, picks));
  }

  if (p === '/api/facets') {
    const picks = me ? store.budgetOf(me).picks : null;
    const r = catalog.query(Object.assign({}, q, { per: 1, page: 0 }), picks);
    return json(req, res, 200, { total: r.total, tagCount: r.tagCount });
  }

  /* ---- eMag, read once and remembered ---- */

  const one = p.match(/^\/api\/emag\/(\d+)$/);
  if (one) {
    const item = catalog.byId(one[1]);
    if (!item) return json(req, res, 404, { error: 'No such product in the list' });
    const row = await emag.rowFor(item, q.force === '1' || q.force === 'true');
    if (row && row.error) return json(req, res, 200, { id: item.id, error: row.error });
    return json(req, res, 200, { id: item.id, emag: row, item: catalog.dress(item, null) });
  }

  if (p === '/api/emag' && req.method === 'POST') {
    const b = await body(req, 256e3);
    const ids = (b.ids || []).slice(0, 120).map(String);
    const force = !!b.force;
    const out = {};
    await Promise.all(ids.map(async id => {
      const item = catalog.byId(id);
      if (!item) { out[id] = { error: 'not in the list' }; return; }
      const row = await emag.rowFor(item, force);
      out[id] = row && row.error ? { error: row.error } : row;
    }));
    return json(req, res, 200, { rows: out });
  }

  /* ---- the budget ---- */

  if (p === '/api/budget' && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!me) return need(res, req);
    const b = store.budgetOf(me);
    const ids = Object.keys(b.picks);
    const items = ids.map(id => {
      const it = catalog.byId(id);
      return it ? catalog.dress(it, b.picks) : null;
    }).filter(Boolean);
    return json(req, res, 200, {
      budget: { cap: b.cap, margin: b.margin, interval: b.interval, startHour: b.startHour, on: b.on, lastRun: b.lastRun },
      items,
      alerts: store.alertsFor(me),
      watcher: watch.state(),
    });
  }

  if (p === '/api/budget' && (req.method === 'PUT' || req.method === 'POST')) {
    if (!me) return need(res, req);
    const b = await body(req);
    return json(req, res, 200, { budget: store.setBudget(me, b) });
  }

  if (p === '/api/budget/pick' && req.method === 'POST') {
    if (!me) return need(res, req);
    const b = await body(req);
    if (!catalog.byId(b.id)) return json(req, res, 404, { error: 'No such product in the list' });
    const after = store.pick(me, b.id, b.remove ? null : b);
    const p2 = after.picks[String(b.id)] || null;
    return json(req, res, 200, { id: +b.id, pick: p2 });
  }

  /* Fill what is left of the budget with the best savings going, biggest first. Not clever, and
     it does not need to be: it is the answer to "what can I actually afford off this list". */
  if (p === '/api/budget/fill' && req.method === 'POST') {
    if (!me) return need(res, req);
    const b = await body(req);
    const bud = store.budgetOf(me);
    const cap = Math.max(0, +b.cap || bud.cap || 0);
    if (!cap) return json(req, res, 400, { error: 'Set a budget first' });
    const q2 = Object.assign({ sort: 'saveDesc', state: 'cheaper', per: 240 }, b.filter || {});
    const found = catalog.query(q2, bud.picks);
    let spent = 0;
    for (const id of Object.keys(bud.picks)) {
      const it = catalog.byId(id);
      if (it && it.price != null) spent += it.price * bud.picks[id].qty;
    }
    const added = [];
    for (const it of found.items) {
      if (bud.picks[String(it.id)] || it.price == null) continue;
      if (spent + it.price > cap) continue;
      store.pick(me, it.id, { qty: 1 });
      spent += it.price;
      added.push(it.id);
      if (added.length >= 40) break;
    }
    return json(req, res, 200, { added, spent: +spent.toFixed(2), cap });
  }

  if (p === '/api/alerts' && req.method === 'DELETE') {
    if (!me) return need(res, req);
    store.clearAlerts(me);
    return json(req, res, 200, { ok: 1 });
  }

  /* One pass of the watcher, now, without waiting for the hour to come round. */
  if (p === '/api/watch/run' && req.method === 'POST') {
    if (!me) return need(res, req);
    const b = store.budgetOf(me);
    b.lastRun = 0;
    watch.tick();
    return json(req, res, 200, { started: 1, watcher: watch.state() });
  }

  if (p === '/api/forget' && req.method === 'POST') {
    if (!me) return need(res, req);
    store.forgetRows();
    return json(req, res, 200, { ok: 1, rows: store.rowCount() });
  }

  return json(req, res, 404, { error: 'No such endpoint' });
}

/* ---------------------------------------------------------------- serving */

const log = (code, what) => console.log(new Date().toISOString().slice(11, 19) + '  ' + code + '  ' + what);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p.startsWith('/api/')) {
    if (req.method === 'OPTIONS') return send(req, res, 204, 'text/plain', '');
    return void api(req, res, p, url).catch(e => {
      log(500, p + '  ' + e.message);
      json(req, res, 500, { error: String(e.message || e) });
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', 'GET only');

  /* what the page probes for: if this answers, it knows it can stop asking the browser directly */
  if (p === '/emag/ping') return send(req, res, 200, 'text/plain', 'ok');

  /* The raw reader the first version of the page used. Still here so an older tab, or the copy on
     GitHub Pages pointed at this address, keeps working. */
  if (p === '/emag') {
    const want = allowed(url.searchParams.get('u') || '');
    if (!want) return send(req, res, 400, 'text/plain', 'Only https addresses on emag.ro are read here');
    return void emag.fetchHtml(want).then(r => {
      send(req, res, r.status === 200 ? 200 : 502, 'text/html; charset=utf-8', r.body);
      log(r.status, (r.cached ? 'kept  ' : 'read  ') + decodeURIComponent(want).slice(0, 90));
    });
  }

  /* static, pinned inside SITE so a crafted path cannot climb out of it */
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(SITE, rel);
  if (file !== SITE && !file.startsWith(SITE + path.sep)) return send(req, res, 403, 'text/plain', 'no');

  fs.readFile(file, (err, buf) => {
    if (err) return send(req, res, 404, 'text/plain', 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    /* the catalog never changes between deploys; everything else should come back fresh */
    send(req, res, 200, type, buf, path.basename(file) === 'products.json' ? 3600 : 0);
  });
});

watch.start();

server.listen(PORT, () => {
  const h = store.health();
  console.log('BF list vs eMag on http://0.0.0.0:' + PORT);
  console.log('list: ' + catalog.info().count + ' products');
  console.log('database: ' + h.file + (h.writable ? '' : '  (NOT WRITABLE -- nothing will be kept)')
    + ', ' + h.rows + ' eMag rows, ' + h.users + ' account(s)');
  console.log('watcher: every ' + watch.state().every + 's, acting on each account schedule');
});
