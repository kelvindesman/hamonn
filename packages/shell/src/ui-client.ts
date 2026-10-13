/**
 * Browser-side glue (plain ES5, no build step). Owns: the bearer header on htmx polls and
 * `data-act` POSTs, the admin-key <dialog>, the aria-live toast region, the live indicator, and
 * the "lane changed state" highlight. It renders facts only; no lane rules live here.
 */
export const CLIENT_JS = `
(function () {
  var KEY = 'hamonn-key';
  var seen = null;
  function key() { return localStorage.getItem(KEY) || ''; }
  function $(id) { return document.getElementById(id); }

  function toast(msg, tone, title) {
    var region = $('toasts');
    var t = document.createElement('div');
    t.className = 'toast';
    t.dataset.tone = tone || 'ok';
    if (title) { var b = document.createElement('b'); b.textContent = title + ' '; t.appendChild(b); }
    t.appendChild(document.createTextNode(msg));
    region.appendChild(t);
    setTimeout(function () { t.remove(); }, tone === 'err' ? 8000 : 4000);
  }

  function keyState() {
    var b = $('keybtn');
    if (b) b.dataset.set = key() ? '1' : '0';
  }
  function openKey() {
    var d = $('keydlg');
    $('keyin').value = key();
    d.showModal();
  }

  function mark() {
    var cards = document.querySelectorAll('[data-lane]');
    var now = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      now[c.dataset.lane] = c.dataset.state;
      if (seen && seen[c.dataset.lane] !== c.dataset.state) c.classList.add('moved');
    }
    seen = now;
  }

  document.addEventListener('DOMContentLoaded', function () {
    keyState();
    mark();
    var d = $('keydlg');
    d.addEventListener('close', function () {
      if (d.returnValue === 'save') {
        localStorage.setItem(KEY, $('keyin').value.trim());
        toast('Admin key saved in this browser.');
      } else if (d.returnValue === 'clear') {
        localStorage.removeItem(KEY);
        toast('Admin key removed from this browser.');
      }
      keyState();
    });
  });

  document.addEventListener('htmx:configRequest', function (e) {
    var k = key();
    if (k) e.detail.headers['Authorization'] = 'Bearer ' + k;
  });
  document.addEventListener('htmx:afterSettle', mark);
  document.addEventListener('htmx:afterRequest', function (e) {
    var l = $('live');
    if (!l) return;
    var ok = e.detail.successful;
    l.dataset.live = ok ? 'on' : 'off';
    l.lastChild.textContent = ok ? 'Live' : 'Reconnecting';
    l.classList.remove('beat');
    void l.offsetWidth;
    if (ok) l.classList.add('beat');
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-key-open]')) { openKey(); return; }
    var b = e.target.closest('[data-act]');
    if (!b) return;
    b.disabled = true;
    fetch(b.dataset.act, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key() },
      body: b.dataset.body || '{}'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok) { toast(b.dataset.done || 'Done.'); return; }
        var err = j.error || {};
        toast(err.message || 'Request failed (' + r.status + ').', 'err', err.code || String(r.status));
        if (r.status === 401) openKey();
      });
    }, function () {
      toast('The request did not reach the server. Check the connection and retry.', 'err', 'Offline');
    }).then(function () {
      b.disabled = false;
      if (window.htmx) htmx.trigger(document.body, 'refresh');
    });
  });
})();
`;
