// ==UserScript==
// @name         BF List vs eMag -- price reader
// @namespace    https://github.com/Cdany2001/EmagList
// @version      1.0
// @description  Lets the BF List page read eMag prices from your own browser, with no proxy in between.
// @match        https://cdany2001.github.io/EmagList/*
// @match        http://localhost:4173/*
// @match        http://127.0.0.1:4173/*
// @connect      emag.ro
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

/* Why this exists: emag.ro sends no CORS headers, so the page itself is not allowed to read its
   replies -- the browser fetches them and then refuses to hand them over. A userscript is not bound
   by that, so the page asks this script instead and this script does the fetching. Same browser,
   same address, same cookies-free request; nothing leaves your machine except the request to eMag. */
(function () {
  'use strict';
  var ALLOW = /^https:\/\/([a-z0-9-]+\.)*emag\.ro(\/|$)/i;
  var UA = navigator.userAgent;

  function reply(msg) { window.postMessage(msg, location.origin); }

  window.addEventListener('message', function (e) {
    // only the page this script was matched into, never a frame or another tab
    if (e.source !== window || e.origin !== location.origin) return;
    var d = e.data;
    if (!d || d.emaglist !== 'ask') return;

    if (d.hello) { reply({ emaglist: 'here', via: 'userscript' }); return; }
    if (!ALLOW.test(d.url || '')) { reply({ emaglist: 'say', id: d.id, ok: false, error: 'only emag.ro addresses' }); return; }

    GM_xmlhttpRequest({
      method: 'GET',
      url: d.url,
      timeout: 20000,
      headers: { 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8', 'User-Agent': UA },
      onload: function (r) { reply({ emaglist: 'say', id: d.id, ok: r.status >= 200 && r.status < 400, status: r.status, body: r.responseText }); },
      onerror: function () { reply({ emaglist: 'say', id: d.id, ok: false, error: 'eMag did not answer' }); },
      ontimeout: function () { reply({ emaglist: 'say', id: d.id, ok: false, error: 'Timed out' }); },
    });
  });

  // the page may have finished loading before this script ran, or the other way round, so say hello
  // both on arrival and whenever asked
  reply({ emaglist: 'here', via: 'userscript' });
  document.addEventListener('DOMContentLoaded', function () { reply({ emaglist: 'here', via: 'userscript' }); });
})();
