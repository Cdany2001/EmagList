/* A content script shares the page's window but not its scripts, so this is the hatch between them:
   the page posts a message, this passes it to the extension, and the answer comes back the same way. */
(function () {
  'use strict';
  const here = () => window.postMessage({ emaglist: 'here', via: 'extension' }, location.origin);

  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.emaglist !== 'ask') return;
    if (d.hello) { here(); return; }
    chrome.runtime.sendMessage({ emaglist: 'ask', url: d.url }, r => {
      const err = chrome.runtime.lastError;
      window.postMessage(Object.assign({ emaglist: 'say', id: d.id },
        err ? { ok: false, error: err.message } : (r || { ok: false, error: 'no answer from the extension' })), location.origin);
    });
  });

  here();
  document.addEventListener('DOMContentLoaded', here);
})();
