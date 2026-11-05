// ==UserScript==
// @name         BF list vs eMag - let the page read eMag
// @namespace    https://cdany2001.github.io/EmagList/
// @version      3.0.0
// @description  Lets the BF list page read emag.ro search pages from your own browser. Nothing else.
// @author       -
// @match        https://cdany2001.github.io/EmagList/*
// @match        http://localhost:4173/*
// @match        http://127.0.0.1:4173/*
// @connect      emag.ro
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

/* The page itself only ever calls fetch(). A script on github.io is not allowed to read a reply
   from emag.ro, so this userscript takes over fetch for emag.ro addresses alone and makes the
   request through your userscript manager instead, which is not bound by that rule. Every other
   address -- including products.json -- goes to the browser's own fetch untouched.

   It runs only on the pages listed above, and it will only talk to emag.ro. */
(function () {
  'use strict';

  const real = window.fetch.bind(window);
  const mine = u => /^https?:\/\/([a-z0-9-]+\.)*emag\.ro\//i.test(u);

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!mine(url)) return real(input, init);

    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        timeout: 20000,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
        },
        onload: function (r) {
          resolve(new Response(r.responseText, {
            status: r.status,
            statusText: r.statusText || '',
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }));
        },
        onerror: function () { reject(new TypeError('eMag could not be reached')); },
        ontimeout: function () { reject(new TypeError('eMag took too long to answer')); },
        onabort: function () { reject(new TypeError('the request to eMag was cancelled')); },
      });
    });
  };

  window.__emagReaderReady = true;
})();
