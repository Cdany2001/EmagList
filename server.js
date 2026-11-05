/* The whole server: it hands out the four static files, and it reads eMag on the page's behalf.

   A page cannot read emag.ro itself -- the browser fetches the reply and then refuses to hand it
   to a script from another origin. A server is under no such rule, so when the site is served from
   here the page asks this process instead, at /emag?u=..., and the answer arrives from its own
   origin. Nothing to install, nothing to switch on.

   Node's standard library only: no package.json, no npm install, no dependencies to keep. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = +(process.env.PORT || 8080);
const SITE = path.join(__dirname, 'site');
const TTL = +(process.env.EMAG_TTL_MIN || 30) * 60e3;   // how long an eMag answer is reused
const MAX_INFLIGHT = +(process.env.EMAG_CONCURRENCY || 3);
const GAP = +(process.env.EMAG_GAP_MS || 250);          // smallest space between two requests
const MAX_CACHED = 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/131.0.0.0 Safari/537.36';

/* ---------------------------------------------------------------- reading eMag */

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

const hits = new Map();   // url -> {t, status, body}
const queue = [];
let inflight = 0, lastStart = 0;

function readEmag(url) {
  const hit = hits.get(url);
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
      hits.set(job.url, res);
      // oldest first out, so a long session cannot grow without limit
      if (hits.size > MAX_CACHED) for (const k of [...hits.keys()].slice(0, hits.size - MAX_CACHED)) hits.delete(k);
    }
    job.resolve(res);
    pump();
  };

  const stop = AbortSignal.timeout(20000);
  fetch(job.url, {
    redirect: 'follow',
    signal: stop,
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

/* ---------------------------------------------------------------- serving */

function send(req, res, status, type, body, cacheFor) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheFor ? 'public, max-age=' + cacheFor : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  // products.json is 3.6 MB of text and this may be going down a tunnel; gzip takes it under 900 KB
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

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', 'GET only');

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // what the page probes for: if this answers, it knows it can stop asking the browser directly
  if (p === '/emag/ping') return send(req, res, 200, 'text/plain', 'ok');

  if (p === '/emag') {
    const want = allowed(url.searchParams.get('u') || '');
    if (!want) return send(req, res, 400, 'text/plain', 'Only https addresses on emag.ro are read here');
    return void readEmag(want).then(r => {
      send(req, res, r.status === 200 ? 200 : 502, 'text/html; charset=utf-8', r.body);
      log(r.status, (r.cached ? 'kept  ' : 'read  ') + decodeURIComponent(want).slice(0, 90));
    });
  }

  // static, pinned inside SITE so a crafted path cannot climb out of it
  const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
  const file = path.resolve(SITE, rel);
  if (file !== SITE && !file.startsWith(SITE + path.sep)) return send(req, res, 403, 'text/plain', 'no');

  fs.readFile(file, (err, buf) => {
    if (err) return send(req, res, 404, 'text/plain', 'Not found');
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // the catalog never changes between deploys; everything else should come back fresh
    send(req, res, 200, type, buf, path.basename(file) === 'products.json' ? 3600 : 0);
  });
});

const log = (code, what) => console.log(new Date().toISOString().slice(11, 19) + '  ' + code + '  ' + what);

server.listen(PORT, () => {
  console.log('BF list vs eMag on http://0.0.0.0:' + PORT);
  console.log('eMag reader: ' + MAX_INFLIGHT + ' at a time, ' + GAP + 'ms apart, answers kept '
    + (TTL / 60e3) + ' min');
});
