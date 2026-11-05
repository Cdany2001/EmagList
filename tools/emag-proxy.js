#!/usr/bin/env node
/* The eMag reader, running on your own machine.

   The site is a static page on GitHub Pages, and eMag sends no CORS headers, so a page served from
   github.io cannot read emag.ro itself -- the browser refuses to hand over the response. The public
   CORS proxies that used to stand in for this are all either dead or blocked by eMag. This is the
   same job done by your own computer instead: the page asks localhost, localhost asks eMag, and the
   requests go out from your address, at your pace, with nothing in between.

   Run it with:  node tools/emag-proxy.js
   Then open Settings in the site and pick "This computer".  PORT=9000 to move it. */
const http = require('http');

const PORT = +(process.env.PORT || 8787);
const OPEN = process.argv.includes('--open');
// eMag only. The page can name any address it likes, and without this it could use your machine as
// an open relay to anywhere, which is not a thing to leave listening on a laptop.
const ALLOW = /^https:\/\/([a-z0-9-]+\.)*emag\.ro(\/|$)/i;
// Who may ask. Anything you visit in the same browser can reach localhost, so the site that this
// serves is named rather than assumed; --open drops the check if you have forked the page elsewhere.
const ORIGINS = [/^https:\/\/[a-z0-9-]+\.github\.io$/i, /^http:\/\/localhost(:\d+)?$/i, /^http:\/\/127\.0\.0\.1(:\d+)?$/i];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TTL = 30 * 60e3;        // a price is not news for half an hour
const MAX = 3;                // at once
const GAP = 250;              // and never closer together than this

const cache = new Map();
let live = 0, lastAt = 0, hits = 0, served = 0, fromCache = 0;
const waiting = [];
const take = () => live < MAX ? (live++, Promise.resolve()) : new Promise(r => waiting.push(r));
const drop = () => { const next = waiting.shift(); if (next) next(); else live--; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function cors(req, res, extra) {
  const o = req.headers.origin;
  const ok = !o || OPEN || ORIGINS.some(re => re.test(o));
  if (!ok) return false;
  res.setHeader('Access-Control-Allow-Origin', o || '*');
  res.setHeader('Vary', 'Origin');
  if (extra) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
    // Chrome asks before letting a public page touch a private address; this is the yes.
    if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return true;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (!cors(req, res, req.method === 'OPTIONS')) { res.writeHead(403).end('origin not allowed'); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  if (u.pathname === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ emaglist: 'proxy', v: 1, served, fromCache, live }));
    return;
  }

  const target = u.searchParams.get('url') || '';
  if (!ALLOW.test(target)) { res.writeHead(400, { 'Content-Type': 'text/plain' }).end('only emag.ro addresses'); return; }

  const hit = cache.get(target);
  if (hit && Date.now() - hit.t < TTL) {
    fromCache++;
    res.writeHead(hit.status, { 'Content-Type': 'text/html; charset=utf-8', 'X-From-Cache': '1' }).end(hit.body);
    return;
  }

  await take();
  try {
    const wait = GAP - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    const t0 = Date.now();
    const r = await fetch(target, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });
    const body = await r.text();
    if (r.ok) cache.set(target, { t: Date.now(), status: r.status, body });
    served++;
    console.log(`${String(++hits).padStart(4)}  ${r.status}  ${String(Date.now() - t0).padStart(5)}ms  ${(body.length / 1024).toFixed(0).padStart(4)}KB  ${target.replace('https://www.emag.ro', '').slice(0, 90)}`);
    res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
  } catch (e) {
    console.log(`      ERR          ${String(e.message).slice(0, 60)}  ${target.slice(0, 70)}`);
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(e.message || e));
  } finally { drop(); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`eMag reader on http://127.0.0.1:${PORT} -- pick "This computer" in the site's Settings.`);
  console.log(`${MAX} requests at once, ${GAP}ms apart, answers kept for ${TTL / 60e3} minutes. Ctrl+C to stop.`);
});
