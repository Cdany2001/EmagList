'use strict';
/* The background task: on each account's own schedule, re-read eMag for the things on its budget
   list and write down the ones that have come within reach.

   It watches and tells you. It does not buy. Placing an order needs an eMag username and password
   kept on this box and replayed at a shop that forbids it, which is a bad trade for the few
   seconds it would save you -- so when a price lands, the alert carries the link and you decide. */

const store = require('./store');
const catalog = require('./catalog');
const emag = require('./emag');

const TICK = 60e3;        /* how often the clock is looked at, not how often eMag is read */
const PER_RUN = 40;       /* products re-read in one pass, so a long list cannot flood eMag */
let timer = null, lastTick = 0, runs = 0;

/* The price you would accept: your own target if you set one, otherwise the list price, with the
   margin as slack on top ("close enough to the listing price"). */
function limitFor(item, p, margin) {
  const base = p && p.target != null ? p.target : item.price;
  if (base == null) return null;
  return +(base * (1 + margin / 100)).toFixed(2);
}

function due(b, now) {
  if (!b.on) return false;
  const d = new Date(now);
  if (d.getHours() < (b.startHour || 0)) return false;   /* before the hour you named, stay quiet */
  return now - (b.lastRun || 0) >= Math.max(5, b.interval || 60) * 60e3;
}

async function sweep(user, b) {
  b.lastRun = Date.now();
  store.save();
  runs++;

  const ids = Object.keys(b.picks || {}).filter(id => {
    const p = b.picks[id];
    return p && p.bought < p.qty;
  }).slice(0, PER_RUN);

  for (const id of ids) {
    const item = catalog.byId(id);
    if (!item) continue;
    const p = b.picks[id];
    const before = store.getRow(id);
    const row = await emag.rowFor(item, true);
    if (!row || row.error || row.price == null) continue;

    const limit = limitFor(item, p, b.margin || 0);
    if (limit == null) continue;

    const was = before && before.price != null ? before.price : null;
    const within = row.price <= limit;

    /* You hear about a price the first time it is within reach of the limit you named -- whether it
       fell to it or was already sitting there when you set the limit -- and not again until it
       climbs back out. hitAt remembers which limit has already been announced. */
    if (within && p.hitAt !== limit) {
      p.hitAt = limit;
      store.addAlert({
        user, id: +id, kind: 'reached',
        name: item.name, list: item.price, price: row.price, was, limit,
        qty: p.qty - p.bought, url: row.url,
      });
    } else if (!within) {
      if (p.hitAt != null) p.hitAt = null;
      if (was != null && row.price < was) {
        store.addAlert({
          user, id: +id, kind: 'drop',
          name: item.name, list: item.price, price: row.price, was, limit,
          qty: p.qty - p.bought, url: row.url,
        });
      }
    }
  }
  store.save();
}

function tick() {
  lastTick = Date.now();
  const budgets = store.budgets();
  for (const user of Object.keys(budgets)) {
    const b = budgets[user];
    if (due(b, lastTick)) sweep(user, b).catch(() => {});
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK);
  if (timer.unref) timer.unref();
}

const state = () => ({ on: !!timer, lastTick, runs, every: TICK / 1000 });

module.exports = { start, tick, state, limitFor };
