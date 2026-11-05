# BF list vs eMag

The 34,083 products from *Listă produse – Preț BF Promo (cu TVA)*, shown a page at a time, each
card comparing the list price with eMag's current one.

There are two ways to run it, and they have nothing to do with each other.

## 1. Docker + a Cloudflare tunnel — the full thing

```bash
docker compose up -d --build
docker compose logs tunnel | grep trycloudflare
```

The second line prints a `https://<random>.trycloudflare.com` address. Open it on any device and
the prices fill themselves in: nothing to install, nothing to switch on, no extension. The site is
also at `http://localhost:8080` while you are at the machine.

This copy has a server behind it, so it has the things a static page cannot have: a database of
eMag prices shared by everyone who opens it, profiles with a username and password, a spending
budget per profile, and a background watcher that keeps checking the prices you are waiting on.

The stack is self-contained. The image carries its own copy of `index.html`, `app.js`,
`styles.css` and `products.json`, and `server.js` does the eMag reading, so it needs nothing from
GitHub Pages and keeps working whatever happens there. The only state that outlives a rebuild is
the `bfemag-data` volume mounted at `/data`; everything else in the container is read-only.

**Why this one just works.** A page may not read `emag.ro` — the browser fetches the reply and
then refuses to hand it to a script from another origin. A *server* is under no such rule, so
`server.js` reads eMag and the page asks it at `/api/emag/<id>`, which is its own origin and
therefore allowed. The page probes `/api/hello` once at startup and takes that route whenever it
answers.

The tunnel is a Cloudflare **quick tunnel**: free, no account, no domain, no port opened on your
router. The address is random and lasts only as long as the `tunnel` container, so restarting it
gives you a new one.

The reader only ever fetches `https` addresses on `emag.ro` — anything else is refused with a 400,
so a leaked tunnel address cannot be turned into an open proxy into your network. It makes 3
requests at a time, 250 ms apart, and keeps each answer 30 minutes; all three are environment
variables in `docker-compose.yml`.

## 2. GitHub Pages — needs a userscript

<https://cdany2001.github.io/EmagList/> serves the same four files, but there is no server on that
origin, so the page has to ask `emag.ro` directly and the browser blocks it. Install
[Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey, open
[`tools/emaglist.user.js`](tools/emaglist.user.js) and confirm: it takes over `fetch` for
`emag.ro` addresses only. Without it every card, and a banner above the grid, says the browser
blocked the request.

The Pages copy keeps liked items, compare picks, settings and every eMag answer in `localStorage`,
in that browser only. It has no budget page to speak of — the Budget tab explains where to find
one — because a budget needs somewhere to live.

## The six pages

- **Catalog** — the whole list, 60 to a page, with search, brand, 13 sorts, *liked only*, a
  collapsible **Sections** panel holding all 57 sections as chips with their counts (pick several
  and say whether a product must be in *any of them* or *all of them*; with *all of them* on, the
  rail drops the sections that would leave you with nothing), and a **More filters** tray for
  eMag price status, a list-price range, a minimum saving and what is on the budget. Every filter
  lives in the address bar, so **Copy link** hands someone the view you are looking at.
- **Top deals** — the widest margins among whatever has been checked so far: three on a podium,
  then the rest of the top sixty. It obeys the catalog's filters, takes a minimum margin, and
  *Check N more* works through the unchecked ones in the background, counting down, stoppable.
- **Liked** — everything you hearted, with totals (your list, the same products on eMag, the gap),
  CSV, one click to send the first four to Compare and one to put the lot on the budget.
- **Budget** — a spending plan the server keeps for you. Name a budget, pick products off the list
  (the basket on any card), set how many of each and what you would pay, and the meter tells you
  where you stand; *Fill it with the best savings* does the picking for you out of the current
  catalog filter. Mark something bought and it is struck off the list and counted at what you
  actually paid. The watcher re-reads those prices on your own interval, after an hour you name,
  and writes down every one that drops or comes within your margin of the target.
  **It watches and tells you; it does not buy.** Ordering would mean keeping an eMag username and
  password on the box and replaying them at a shop whose terms forbid it, so when a price lands
  the alert carries the link and you decide.
- **Compare** — up to four side by side: both prices, the saving, brand, sections, what it matched
  on eMag and how confidently, then whatever the name gives up (power, capacity, storage, RAM,
  screen, battery, speed, pressure). The best cell in each numeric row is marked.
- **Settings** — where prices come from, with a live connection test; what this server holds (list,
  database, profiles, watcher, reads); how many requests at once and how long an answer is reused;
  how much is saved and a button to forget it, locally or on the server; a JSON backup you can
  export and import; dense cards; light, dark or follow the system; and the keyboard shortcuts.

Keys: `/` search, `g` then `c d l b k s` for the pages, `f` more filters, `t` sections, `←`/`→`
paging, `Esc` clears the search.

**On a phone** the six pages move to a bar along the bottom edge, within thumb reach, each
carrying its own count in the corner. The title and the filters scroll away rather than holding a
third of the screen, every control grows to a size a thumb can hit, and text fields are set at 16px
because anything smaller makes Safari zoom the whole page the moment you tap one. Nothing is cut
off down to 320px, the narrowest phone still in use.

## How it works

1. **The list is hardcoded.** `products.json` holds all 34,083 rows as `[nr, name, price, brandIndex, [tagIndexes]]` — 3.6 MB raw, about 880 KB gzipped — and is shown 60 products a page.
2. **eMag is asked per product, by name.** eMag cannot be asked for a product by title, so it searches `emag.ro/search/<first ten words of the name>` and picks the result whose name is closest: an exact name wins outright, otherwise the best token overlap, with model numbers (`HF5075`, `ECAM450`) weighted four times a plain word and eMag's own ranking breaking a tie. A thin match prints the name it settled on, in red.
3. **Nothing is fetched before it is needed.** Each card is watched with an `IntersectionObserver` and asks once it comes within 400 px of the viewport, three at a time.
4. **An answer is read once.** On the self-hosted copy the first ask for a product goes to eMag and lands in the database; every later ask, from any device, is served from there, with the lowest price ever seen and a short price history kept alongside. **Force refresh** — the arrow on a card, or *Check these again* on a page — is the one thing that goes back to eMag for something already known.

## Files

- `index.html`, `styles.css`, `app.js` — the page
- `products.json` — the list
- `server.js` — the static server, the eMag reader and the API
- `lib/store.js` — the database: profiles, sessions, prices, budgets, alerts, in one JSON file
- `lib/catalog.js` — the list in memory, with the query and the section counts behind the filters
- `lib/emag.js` — reading and parsing eMag search pages, and the name matcher
- `lib/watch.js` — the background watcher
- `Dockerfile`, `docker-compose.yml` — the self-hosted stack
- `tools/emaglist.user.js` — what the GitHub Pages copy needs instead

A profile is a name, a password kept as a scrypt hash, and the budget it belongs to. It is not an
eMag account and it is not connected to one.

117 products are named `0` and 216 have no name in the source PDF; they are kept and shown as
*(no name in the source list)*. 61 have no list price.
