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

eMag has no public API, and a page served from github.io is not allowed to read emag.ro's replies: the
browser fetches them and then refuses to hand them to a script from another origin. Something on your
own device has to make the request instead. There are three ways, and **Settings → Where eMag prices
come from** picks between them (the default, *Whatever is available*, tries them in this order):

**1. A userscript — nothing to run.** Install [Tampermonkey](https://www.tampermonkey.net/) or
Violentmonkey, then open [`tools/emaglist.user.js`](tools/emaglist.user.js) and confirm the install.
It fetches eMag inside your browser and hands the page back. It only touches `emag.ro`, and only on
this site.

**2. The extension — also nothing to run.** Download `tools/extension/`, open `chrome://extensions`,
switch on Developer mode and press *Load unpacked* on that folder. Same job, same limits, no
userscript manager needed.

**3. A reader on this computer.** In the project folder:

```
node tools/emag-proxy.js
```

It listens on `http://127.0.0.1:8787`, fetches eMag three requests at a time with a 250 ms gap, keeps
each answer for half an hour, and refuses any address that is not eMag — and any caller that is not
this site. `PORT=9000 node tools/emag-proxy.js` moves it; set the same number in Settings.

Public CORS proxies are still in Settings as a last resort, but somebody else's server then sees your
whole list and can be blocked or switched off without warning. Every public one was failing when this
was written.

Whichever way the request goes, the result is cached in IndexedDB, so each product is read at most
once every 72 hours (configurable). Cards on screen load on their own; *Load eMag prices for these*
does the whole filtered view. If eMag picks the wrong product, open the product and paste the exact
eMag link or the price under **Fix the eMag match**.

## Files

- `index.html`, `styles.css`, `app.js`: the app (no build step)
- `data/index.json` + `data/c0.json`…`c136.json`: the catalog in 250-product chunks, fetched as you scroll. The index holds the product count, the tag and brand tables and a count per tag, which is enough to lay out all 34,083 rows before any of them have arrived
- `products.json`: the whole list as `[nr, name, price, brandIndex, [tagIndexes]]`. Nothing fetches it; it is the source `tools/split-data.js` splits into `data/`
- `tools/emag-proxy.js`, `tools/emaglist.user.js`, `tools/extension/`: the three ways of reading eMag from your own device
- 117 products have the name `0` and 216 have no name in the source PDF. They are kept and tagged `no-name`. 61 products have no price and are tagged `no-price`.

## Deploy

GitHub → repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**. The site appears at `https://cdany2001.github.io/EmagList/`.
