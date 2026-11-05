/* Which of eMag's search results is the product we meant.

   Both halves of the site use this one file -- the page loads it before app.js, the server
   requires it -- so a row read in a browser and a row read on the server can never disagree.

   The whole method rests on one thing the list tells us about itself. A word nearly every name
   uses says almost nothing about which product is meant: "cu" is in 14,997 of the 34,083 names,
   "pantofi" in 7,147, "negru" in 8,484. A word two names use says almost everything: "goalgetter"
   is in 11, "hf5075" in exactly 1. So nothing here is weighted by hand. Every word is weighted by
   how rare it is across the whole list, and the rest of the file is that one idea applied twice:
   to choosing which words we send to eMag, and to judging which result came back.

   What it replaces: a query of the first ten words of the name, and a score that counted how many
   of our words a title repeated. The first spent its ten words on "cu", "de" and "fara" and then
   cut the name off mid-word at ninety characters, which is how a model number that would have
   found the thing outright got thrown away. The second gave "cu" exactly as much say as
   "solarstrike", so a Puma teamGOAL shirt matched an Essentials one and a twenty-piece Tefal set
   matched the four-piece. */

(function (root, make) {
  const api = make();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MATCH = api;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const norm = s => String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /* "2000 W" and "6 L" are each one fact, so a lone unit letter joins the number in front of it.
     Both sides are read this way, so our "6 L" and their "6l" are the same token. */
  function tok(s) {
    const out = [];
    for (const t of norm(s).split(/[^a-z0-9]+/)) {
      if (!t) continue;
      const prev = out[out.length - 1];
      if (t.length === 1 && prev && /\d$/.test(prev)) {
        out[out.length - 1] = prev + t;
        continue;
      }
      if (t.length > 1) out.push(t);
    }
    return out;
  }

  /* The list ends a fashion name with the variant it is -- ", Rosu, Argintiu, 6.5" -- while eMag
     sells one page per model and usually leaves the size out of the title. A trailing size is
     dropped rather than counted against a result for not repeating it. Only a trailing one: "24
     cm" in the middle of a pan lid's name is what the lid is, not which one of it you get. */
  const SIZE = /^(\d{1,3}([.,]\d+)?\s*(eu|uk|us|cm|mm)?|\d?x{0,3}(s|m|l|xl)|w\s*\d+\s*-?\s*l\s*\d+|\d{2,3}\s*\/\s*\d{2,3})$/;
  function core(name) {
    const parts = String(name == null ? '' : name).split(',');
    while (parts.length > 1 && SIZE.test(norm(parts[parts.length - 1]).trim())) parts.pop();
    return parts.join(',');
  }

  /* ---- how rare is a word ------------------------------------------------------------------ */

  let DF = null, DOCS = 0;

  /* Counted once from the list both copies already hold, so there is no table to ship and
     nothing that can fall out of step with products.json. It costs about a seventh of a second
     over all 34,083 names, which is why the caller does it on the first match rather than at
     startup: by then the page is already waiting on eMag for something far longer. */
  function learn(names) {
    const df = Object.create(null);
    let n = 0;
    for (const name of names) {
      n++;
      for (const t of new Set(tok(name))) df[t] = (df[t] || 0) + 1;
    }
    DF = df;
    DOCS = n || 1;
    return n;
  }

  const learned = () => DF !== null;

  /* 1 for a word no other name uses, near 0 for a word the whole list uses. Squared, because the
     plain logarithm left "solarstrike" only four times the say of "pantofi" and the point is that
     one of them identifies a shoe and the other is every shoe in the list. Without the table
     every word weighs the same, which is where this started. */
  function weight(t) {
    if (!DF) return 1;
    const df = DF[t] || 0.5;
    let w = Math.log(DOCS / df) / Math.log(DOCS * 2);
    w = w * w;
    return w < 0.004 ? 0.004 : w > 1 ? 1 : w;
  }

  /* Two things rarity gets wrong on its own, both of them read off the list rather than guessed.

     Colour is the first. 32,595 of the 34,083 names end in a comma segment, and its commonest
     words are overwhelmingly colours -- negru in 6,195 of them, albastru in 2,375. Rarity
     therefore gives colour almost no say, but eMag sells one page per colourway and keeps the
     sizes on it, so the colour IS which product you get. A colour that disagrees outright is a
     different product, however ordinary the word for it is. Shade words -- inchis, deschis,
     stins, murdar -- are left out, since they qualify a colour rather than being one.

     The brand is the second. It is usually a middling-rare word and so carries middling weight,
     but it is the one word in a name that cannot be wrong, so it is never allowed to weigh
     little. */
  const HUE = new Set(('negru alb albastru gri maro verde bleumarin argintiu roz bej auriu rosu '
    + 'ultramarin carbon camel crem kaki taupe masliniu portocaliu lime galben violet mov turcoaz '
    + 'bordo vernil fucsia fuchsia somon nude grena indigo oliv antracit cupru bronz sampanie '
    + 'ciclam piersica lavanda mentol petrol mustar visiniu teracota black white blue grey green '
    + 'red pink navy beige ivory').split(' '));

  const hues = set => {
    const out = [];
    for (const t of set) if (HUE.has(t)) out.push(t);
    return out;
  };

  /* ---- judging a result -------------------------------------------------------------------- */

  /* An identical name is the whole answer. The old rule also took a title that merely began like
     ours, so any 26-character prefix won outright; the shorter now has to be most of the longer
     before that counts. */
  function same(a, b) {
    if (a === b) return true;
    const s = a.length < b.length ? a : b;
    const l = a.length < b.length ? b : a;
    return s.length >= 20 && s.length >= l.length * 0.75 && l.indexOf(s) === 0;
  }

  /* Both directions matter and they catch different mistakes. Missing our rare words is how a
     teamGOAL shirt becomes an Essentials one; carrying rare words of its own is how a four-piece
     set, or a case for the thing instead of the thing, gets in. Recall counts for more of the two
     because eMag drops the size and colour we carry far more often than it invents a model. */
  /* Below this much shared rarity, a name has not said enough to identify anything. "United
     Colors of Benetton, Geaca matlasata" is five words the list uses thousands of times over, and
     a ratio over those five is not evidence -- every quilted Benetton jacket matches it perfectly.
     So a ratio has to be earned in absolute terms as well, and a name with little in it cannot
     produce a confident match at all, which is the honest answer. */
  const EVIDENCE = 2;

  function score(ourName, theirTitle, brand) {
    const a = new Set(tok(core(ourName)));
    const b = new Set(tok(theirTitle));
    if (!a.size || !b.size) return 0;
    const own = brand ? new Set(tok(brand)) : null;
    const w = t => {
      const base = weight(t);
      return own && own.has(t) && base < 0.5 ? 0.5 : base;
    };

    let shared = 0, ours = 0, theirs = 0;
    for (const t of a) { const x = w(t); ours += x; if (b.has(t)) shared += x; }
    for (const t of b) theirs += w(t);
    if (!ours || !theirs || !shared) return 0;

    const r = shared / ours, p = shared / theirs;
    let s = 5 * p * r / (4 * p + r);
    if (shared < EVIDENCE) s *= shared / EVIDENCE;

    const mine = hues(a), yours = hues(b);
    if (mine.length && yours.length && !mine.some(h => yours.indexOf(h) >= 0)) s *= 0.45;
    return s;
  }

  /* eMag's own ranking is worth something -- it put its best guess first -- but only enough to
     settle results this cannot tell apart. */
  function closest(name, hits, opts) {
    const list = hits || [];
    if (!list.length) return null;
    const o = opts || {};
    const want = norm(name);
    for (const h of list) {
      if (same(norm(h.title), want)) return Object.assign({ score: 1 }, h);
    }
    /* Every result eMag returned, not the first handful. The right Tefal set -- the one that says
       20 Piese, as ours does -- comes back seventeenth, and scoring sixty titles costs nothing
       next to the request that fetched them. */
    let best = null;
    const look = o.cap ? list.slice(0, o.cap) : list;
    for (let i = 0; i < look.length; i++) {
      const s = score(name, look[i].title, o.brand) - i * 0.004;
      if (!best || s > best.s) best = { s: s, h: look[i] };
    }
    if (!best) return null;
    return Object.assign({ score: +Math.max(0, best.s).toFixed(2) }, best.h);
  }

  /* ---- what to ask eMag -------------------------------------------------------------------- */

  /* The words that carry the most information, in the order they were written, never split in
     half -- the old query cut the Electrolux name off at "SteamBak".

     Two slots are spoken for before rarity gets a say, because a search engine wants different
     things from a name than a comparison does. It wants the brand, which is the one word that
     cannot be wrong, and it wants to be told what the thing is; both are words the list uses often
     enough that rarity on its own throws them out, and the first ask for the Braun air fryer went
     out carrying neither "Friteuza" nor "Braun". The first word of a name is the brand or the
     category in nearly every row here, so it is kept as written, and the brand is added if the
     name never says it.

     Tier 0 is the ordinary ask. Tier 1 is the retry for when the first came back with nothing, or
     with nothing convincing: the same two slots and only the three rarest words after them, which
     is almost always brand plus model. */
  const WORDS = [8, 5];
  const CHARS = [78, 52];

  function queryFor(name, tier, brand) {
    const t = tier ? 1 : 0;
    const clean = s => String(s == null ? '' : s)
      .replace(/[^A-Za-z0-9À-ɏ%+.\- ]+/g, ' ')
      .split(/\s+/)
      .map(w => w.replace(/^[.\-+]+|[.\-+]+$/g, ''))
      .filter(w => w && /[A-Za-z0-9]/.test(w));

    const words = clean(core(name)).map((w, i) => ({ w, i }));
    if (!words.length) return '';

    const own = new Set(brand ? tok(brand) : []);
    for (const o of words) {
      let best = 0;
      for (const k of tok(o.w)) {
        if (own.has(k)) best = 1.5;              /* the brand is never dropped */
        best = Math.max(best, weight(k));
      }
      /* A word no token survives -- "3in1" keeps its own -- still beats nothing. */
      o.k = best || 0.2;
    }
    words[0].k = 2;                              /* nor is what the thing is */

    const keep = words.slice()
      .sort((x, y) => y.k - x.k || x.i - y.i)
      .slice(0, WORDS[t])
      .sort((x, y) => x.i - y.i)
      .map(o => o.w);

    /* A name that never says its brand gets it in front, where eMag reads it first. */
    const said = new Set(keep.join(' ').split(' ').flatMap(w => tok(w)));
    if (own.size && ![...own].some(k => said.has(k))) keep.unshift(...clean(brand).slice(0, 2));

    let out = '';
    for (const w of keep) {
      const add = out ? ' ' + w : w;
      if (out && out.length + add.length > CHARS[t]) break;
      out += add;
    }
    return out || words[0].w.slice(0, CHARS[t]);
  }

  const searchURL = (name, tier, brand) =>
    'https://www.emag.ro/search/' + encodeURIComponent(queryFor(name, tier, brand));

  /* A first ask that found nothing, or found nothing that looks like the thing, is worth one
     retry with just the brand and the model. Below this a match is shown in red either way. */
  const THIN = 0.45;

  return {
    norm, tok, core, learn, learned, weight, score, closest, same,
    queryFor, searchURL, THIN, tiers: WORDS.length,
  };
}));
