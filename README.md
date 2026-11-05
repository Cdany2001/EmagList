# BF list vs eMag

The 34,083 products from *Listă produse – Preț BF Promo (cu TVA)*, shown a page at a time, each
card comparing the list price with eMag's current one.

There are two ways to run it, and they have nothing to do with each other.

## 1. Docker + a Cloudflare tunnel — eMag loads on its own

```bash
docker compose up -d --build
docker compose logs tunnel | grep trycloudflare
```

The second line prints a `https://<random>.trycloudflare.com` address. Open it on any device and
the prices fill themselves in: nothing to install, nothing to switch on, no extension. The site is
also at `http://localhost:8080` while you are at the machine.

This stack is self-contained. The image carries its own copy of `index.html`, `app.js`,
`styles.css` and `products.json`, and `server.js` does the eMag reading, so it needs nothing from
GitHub Pages and keeps working whatever happens there.

**Why this one just works.** A page may not read `emag.ro` — the browser fetches the reply and
then refuses to hand it to a script from another origin. A *server* is under no such rule, so
`server.js` reads eMag and the page asks it at `/emag?u=…`, which is its own origin and therefore
allowed. The page probes `/emag/ping` once at startup and takes that route whenever it answers.

The tunnel is a Cloudflare **quick tunnel**: free, no account, no domain, no port opened on your
router. The address is random and lasts only as long as the `tunnel` container, so restarting it
gives you a new one.

The reader only ever fetches `https` addresses on `emag.ro` — anything else is refused with a 400,
so a leaked tunnel address cannot be turned into an open proxy into your network. It makes 3
requests at a time, 250 ms apart, and keeps each answer 30 minutes; all three are environment
variables in `docker-compose.yml`.

## 2. GitHub Pages — needs a userscript

<https://cdany2001.github.io/EmagList/> serves the same four files, but there is no reader on that
origin, so the page has to ask `emag.ro` directly and the browser blocks it. Install
[Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey, open
[`tools/emaglist.user.js`](tools/emaglist.user.js) and confirm: it takes over `fetch` for
`emag.ro` addresses only. Without it every card, and a banner above the grid, says the browser
blocked the request.

## The five pages

- **Catalog** — the whole list, 60 to a page, with search, brand, sort, *cheaper than eMag*,
  *liked only*, and a **Sections** panel holding all 57 sections as chips with their counts; pick
  several and say whether a product must be in *any of them* or *all of them*.
- **Top deals** — the widest margins among whatever has been checked so far: three on a podium,
  then the rest of the top sixty. It obeys the catalog's filters, takes a minimum margin, and
  *Check N more* works through the unchecked ones in the background, counting down, stoppable.
- **Liked** — everything you hearted, with totals (your list, the same products on eMag, the gap),
  an optional budget with a meter that turns red when you are over it, CSV, and one click to send
  the first four to Compare.
- **Compare** — up to four side by side: both prices, the saving, brand, sections, what it matched
  on eMag and how confidently, then whatever the name gives up (power, capacity, storage, RAM,
  screen, battery, speed, pressure). The best cell in each numeric row is marked.
- **Settings** — where prices come from, with a live connection test; how many requests at once and
  how long an answer is reused; how much is saved and a button to forget it; a JSON backup you can
  export and import; light, dark or follow the system.

Liked items, compare picks, settings and every eMag answer live in `localStorage`, in that browser
only. Nothing is sent anywhere.

## How the page itself works

1. **The list is hardcoded.** `products.json` holds all 34,083 rows as `[nr, name, price, brandIndex, [tagIndexes]]`, fetched once at startup — 3.6 MB raw, about 880 KB gzipped — and shown 60 products a page.
2. **eMag is asked per card, by name.** eMag cannot be asked for a product by title, so the app searches `emag.ro/search/<first ten words of the name>` and picks the result whose name is closest: an exact name wins outright, otherwise the best token overlap, with model numbers (`HF5075`, `ECAM450`) weighted four times a plain word and eMag's own ranking breaking a tie. A thin match prints the name it settled on, in red.
3. **Nothing is fetched before it is needed.** Each card is watched with an `IntersectionObserver` and asks once it comes within 400px of the viewport, three requests at a time. Answers are kept in `localStorage` for a day, so paging back and forth does not ask twice. The other pages work off the same queue, which is why a page you leave open keeps filling in.

## Files

- `index.html`, `styles.css`, `app.js` — the page
- `products.json` — the list
- `server.js`, `Dockerfile`, `docker-compose.yml` — the self-hosted stack
- `tools/emaglist.user.js` — what the GitHub Pages copy needs instead

117 products are named `0` and 216 have no name in the source PDF; they are kept and shown as
*(no name in the source list)*. 61 have no list price.
