# BF list vs eMag

A static catalog of the 34,083 products from *Listă produse – Preț BF Promo (cu TVA)*, compared with live eMag prices. No backend: it runs entirely in the browser on GitHub Pages.

## Features

- Catalog of all 34,083 products with a picture, list price, eMag price, and a sticker showing the saving vs eMag (lei and %)
- Sort and filter by saving (lei or %), list price, eMag price, brand, wishlist, and tags
- Tags on every product: category, brand, and audience (men, women, kids…) built from the names, plus eMag's own categories once an item is loaded, plus your own tags
- Tap a tag once to include it, twice to exclude it, with Any/All matching
- "Open in eMag" on every card
- Multiple wishlists with budget, totals, and savings, stored in `localStorage`
- Compare up to 4 products side by side, including eMag specifications
- CSV export (all products, or a wishlist), plus backup and restore of your data

## How eMag data is loaded

eMag has no public API that a static site can call, and browsers block direct requests to emag.ro from another site (CORS). The app reads eMag's search and product pages through a public CORS proxy and caches the result in IndexedDB, so each product is fetched at most once every 72 hours (configurable).

- Cards on screen load automatically. "Load eMag prices for these" loads the whole filtered view.
- Proxies are set in **Settings** (one per line, `{url}` = encoded eMag address). The defaults are allorigins, corsproxy.io, and codetabs.
- If eMag picks the wrong product or blocks a request, open the product and paste the exact eMag link or type the price under **Fix the eMag match**.

### Optional: your own proxy (more reliable)

Public proxies are shared and rate-limited. A free Cloudflare Worker gives you a private one. Create a Worker with the code below, then put `https://YOUR-WORKER.workers.dev/?url={url}` first in Settings.

```js
export default {
  async fetch(req) {
    const target = new URL(req.url).searchParams.get('url');
    if (!target || !/^https:\/\/www\.emag\.ro\//.test(target)) return new Response('Only emag.ro', { status: 400 });
    const r = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ro-RO,ro;q=0.9' } });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
  },
};
```

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `products.json` (or `data/products.json`): products as `[nr, name, price, brandIndex, [tagIndexes]]`, with `tags` and `brands` lookup tables
- 117 products have the name `0` and 216 have no name in the source PDF. They are kept and tagged `no-name`. 61 products have no price and are tagged `no-price`.

## Deploy

GitHub → repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**. The site appears at `https://cdany2001.github.io/EmagList/`.
