/* The half of the bridge that is allowed to read emag.ro. An extension granted host_permissions is
   outside the same-origin rules the page lives under, so the fetch here comes back readable -- the
   same request the page would have made, made by something permitted to look at the answer. */
const ALLOW = /^https:\/\/([a-z0-9-]+\.)*emag\.ro(\/|$)/i;

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.emaglist !== 'ask') return;
  if (!ALLOW.test(msg.url || '')) { send({ ok: false, error: 'only emag.ro addresses' }); return true; }

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 20000);
  fetch(msg.url, {
    signal: ac.signal,
    credentials: 'omit',
    headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8' },
  })
    .then(async r => send({ ok: r.ok, status: r.status, body: await r.text() }))
    .catch(e => send({ ok: false, error: e.name === 'AbortError' ? 'Timed out' : 'eMag did not answer' }))
    .finally(() => clearTimeout(to));
  return true;                            // the reply comes later
});
