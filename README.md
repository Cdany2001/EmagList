# BF list vs eMag

The 34,083 products from *Listă produse – Preț BF Promo (cu TVA)*, shown a page at a time, each
card comparing the list price with eMag's current one. Three files and a JSON: no build step, no
backend, no helper running anywhere.

## How it works

1. **The list is hardcoded.** `products.json` holds all 34,083 rows as `[nr, name, price, brandIndex, [tagIndexes]]`. It is fetched once at startup — 3.6 MB raw, which GitHub Pages serves gzipped at about 890 KB — and shown 60 products a page.
2. **eMag is asked per card, by name.** eMag has no way of being asked for a product by title, so the app searches `emag.ro/search/<first ten words of the name>`, then picks the result whose name is closest to ours: an exact name wins outright, otherwise the best token overlap, with model numbers (`HF5075`, `A2316`) weighted four times a plain word and eMag's own ranking breaking a tie. That result's price, previous price and picture are what the card shows; if the match is thin the name is printed under the title in red so you can see what it settled on.
3. **Nothing is fetched before it is needed.** Each card is watched with an `IntersectionObserver`; it asks eMag once it comes within 400px of the viewport, and never before. Three requests run at a time. Answers are kept in `localStorage` for a day (the most recent 4,000), so paging back and forth does not ask twice.
4. **No proxy and no helper.** The app makes exactly one kind of request to eMag — a plain `fetch` — and contains no transport code beyond it.

## The one thing that needs installing

A page served from `github.io` is not allowed to read `emag.ro`: the browser makes the request and
then refuses to hand the reply to a script from another origin, and eMag sends no header that
waives it. Nothing in the page can change that, so point 4 above has a cost — without help, every
card reports the block instead of a price.

Install [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey, open
[`tools/emaglist.user.js`](tools/emaglist.user.js) and confirm. It takes over `fetch` for
`emag.ro` addresses only and makes those requests through the userscript manager, which is not
bound by that rule. 50 lines, one site, no server.

## Files

- `index.html`, `styles.css`, `app.js` — the app
- `products.json` — the list
- `tools/emaglist.user.js` — the userscript described above

117 products are named `0` and 216 have no name in the source PDF; they are kept and shown as
*(no name in the source list)*. 61 have no list price.

## Deploy

GitHub → **Settings → Pages → Deploy from a branch → `main` / root**. The site is at
<https://cdany2001.github.io/EmagList/>.
