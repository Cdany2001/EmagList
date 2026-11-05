'use strict';
/* The only state that outlives a restart: accounts, their sessions, the eMag rows already read,
   each account's budget list and the watcher's log. One JSON file, written whole — plenty for a
   few thousand rows, and it keeps the image free of a database. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'db.json');
const MAX_EMAG = 40000;   /* the whole list would fit, but a cap keeps the file sane */
const MAX_HIST = 24;      /* price points kept per product */
const MAX_ALERTS = 300;
const SESSION_DAYS = 30;

const blank = () => ({ v: 1, users: {}, sessions: {}, emag: {}, budgets: {}, alerts: [] });
let db = blank();
let writable = true;

try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { writable = false; }
try { db = Object.assign(blank(), JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first run */ }

/* Sessions that ran out while we were off. */
const now = Date.now();
for (const t of Object.keys(db.sessions)) if (!db.sessions[t] || db.sessions[t].exp < now) delete db.sessions[t];

let timer = null, writing = false, again = false;
function flush() {
  if (!writable) return;
  if (writing) { again = true; return; }
  writing = true; again = false;
  const tmp = FILE + '.' + process.pid + '.tmp';
  let body;
  try { body = JSON.stringify(db); } catch (e) { writing = false; return; }
  fs.writeFile(tmp, body, err => {
    if (err) { writable = false; writing = false; return; }
    fs.rename(tmp, FILE, e2 => {
      writing = false;
      if (e2) writable = false;
      else if (again) save();
    });
  });
}
/* Written on a leash: answers arrive in bursts while a page fills in. */
function save() { clearTimeout(timer); timer = setTimeout(flush, 800); }

/* ---- accounts ------------------------------------------------------------------------------ */

function hashOf(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }

function addUser(name, pw) {
  name = String(name || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 40) return 'A username needs 2 to 40 characters.';
  if (String(pw || '').length < 8) return 'A password needs at least 8 characters.';
  if (db.users[name]) return 'That username is taken.';
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[name] = { salt, hash: hashOf(pw, salt), made: Date.now() };
  save();
  return null;
}

function checkUser(name, pw) {
  name = String(name || '').trim().toLowerCase();
  const u = db.users[name];
  if (!u) return null;
  const a = Buffer.from(hashOf(pw, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return name;
}

function anyUser() { return Object.keys(db.users).length > 0; }

function openSession(name) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = { user: name, exp: Date.now() + SESSION_DAYS * 864e5 };
  save();
  return token;
}

function whoIs(token) {
  const s = token && db.sessions[token];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[token]; save(); return null; }
  return s.user;
}

function closeSession(token) { if (token && db.sessions[token]) { delete db.sessions[token]; save(); } }

/* ---- eMag rows ----------------------------------------------------------------------------- */

function getRow(id) { return db.emag[id] || null; }

function putRow(id, row) {
  const had = db.emag[id];
  const hist = (had && had.hist) || [];
  if (row && row.price != null && (!hist.length || hist[hist.length - 1][1] !== row.price)) {
    hist.push([Date.now(), row.price]);
    while (hist.length > MAX_HIST) hist.shift();
  }
  let low = had && had.low != null ? had.low : null, lowAt = had ? had.lowAt : 0;
  if (row && row.price != null && (low == null || row.price < low)) { low = row.price; lowAt = Date.now(); }
  db.emag[id] = Object.assign({}, row, { t: Date.now(), hist, low, lowAt });
  if (Object.keys(db.emag).length > MAX_EMAG) {
    const keys = Object.keys(db.emag).sort((a, b) => db.emag[a].t - db.emag[b].t);
    for (let i = 0; i < keys.length - MAX_EMAG; i++) delete db.emag[keys[i]];
  }
  save();
  return db.emag[id];
}

function rowCount() { return Object.keys(db.emag).length; }
function allRows() { return db.emag; }

function forgetRows() { db.emag = {}; save(); }

/* ---- budgets ------------------------------------------------------------------------------- */

const freshBudget = () => ({ cap: 0, margin: 5, interval: 60, startHour: 9, on: false, picks: {}, lastRun: 0 });

function budgetOf(user) {
  if (!db.budgets[user]) db.budgets[user] = freshBudget();
  const b = db.budgets[user];
  if (!b.picks) b.picks = {};
  return b;
}

function setBudget(user, patch) {
  const b = budgetOf(user);
  const n = v => (Number.isFinite(+v) ? +v : 0);
  if ('cap' in patch) b.cap = Math.max(0, n(patch.cap));
  if ('margin' in patch) b.margin = Math.min(50, Math.max(0, n(patch.margin)));
  if ('interval' in patch) b.interval = Math.min(1440, Math.max(5, n(patch.interval) || 60));
  if ('startHour' in patch) b.startHour = Math.min(23, Math.max(0, Math.round(n(patch.startHour))));
  if ('on' in patch) b.on = !!patch.on;
  save();
  return b;
}

function pick(user, id, patch) {
  const b = budgetOf(user);
  id = String(id);
  if (patch === null) { delete b.picks[id]; save(); return b; }
  const p = b.picks[id] || { qty: 1, bought: 0, target: null, added: Date.now() };
  if ('qty' in patch) p.qty = Math.min(99, Math.max(1, Math.round(+patch.qty) || 1));
  if ('target' in patch) p.target = patch.target == null || patch.target === '' ? null : Math.max(0, +patch.target);
  if ('bought' in patch) {
    p.bought = Math.min(p.qty, Math.max(0, Math.round(+patch.bought) || 0));
    p.boughtAt = p.bought ? Date.now() : 0;
    if ('boughtPrice' in patch) p.boughtPrice = patch.boughtPrice == null ? null : +patch.boughtPrice;
  }
  b.picks[id] = p;
  save();
  return b;
}

/* ---- the watcher's log --------------------------------------------------------------------- */

function addAlert(a) {
  db.alerts.unshift(Object.assign({ t: Date.now() }, a));
  while (db.alerts.length > MAX_ALERTS) db.alerts.pop();
  save();
}
function alertsFor(user) { return db.alerts.filter(a => a.user === user).slice(0, 80); }
function clearAlerts(user) { db.alerts = db.alerts.filter(a => a.user !== user); save(); }

function health() {
  let bytes = 0;
  try { bytes = fs.statSync(FILE).size; } catch (e) { bytes = 0; }
  return { writable, file: FILE, bytes, rows: rowCount(), users: Object.keys(db.users).length };
}

module.exports = {
  addUser, checkUser, anyUser, openSession, whoIs, closeSession,
  getRow, putRow, rowCount, allRows, forgetRows,
  budgetOf, setBudget, pick, freshBudget,
  addAlert, alertsFor, clearAlerts,
  users: () => db.users, budgets: () => db.budgets, health, save
};
