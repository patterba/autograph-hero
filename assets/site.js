// Filters the cards on the "All signings" page. The page works without this
// script (every signing is in the HTML); this only narrows what is shown.
(function () {
  var form = document.getElementById('filters');
  if (!form) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll('#results .card'));
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var keys = ['q', 'what', 'type', 'state'];
  // Category names in the "What" picker match data-cat; any other value is a sport (data-sport).
  var CATEGORIES = ['Sports', 'Entertainment', 'Musicians', 'Authors', 'Artists'];

  // Start from the address bar, so links like /events/?what=Football work.
  var params = new URLSearchParams(location.search);
  // Older links used ?sport=Football.
  if (!params.get('what') && params.get('sport')) params.set('what', params.get('sport'));
  keys.forEach(function (k) {
    var el = form.elements[k];
    var v = params.get(k);
    if (!el || !v) return;
    if (el.tagName === 'SELECT') {
      var ok = Array.prototype.some.call(el.options, function (o) { return o.value === v; });
      if (ok) el.value = v;
    } else {
      el.value = v;
    }
  });

  // No results. Logged out: always ask the fan to sign up for alerts (Sign Up with
  // what they searched filled in as a favorite). Logged in members already get
  // alerts, so they see the plain "add a signing we don't have" message.
  var alertBox = empty.querySelector('[data-empty="alerts"]');
  var filtersBox = empty.querySelector('[data-empty="filters"]');
  var signupHref = alertBox ? alertBox.querySelector('[data-empty-signup]').getAttribute('href') : '';

  // Same 72-hour rule as assets/app.js and account.js.
  function loggedIn() {
    try {
      var s = JSON.parse(localStorage.getItem('ah-session') || 'null');
      return !!(s && s.access_token && (!s.signed_in_at || Date.now() / 1000 - s.signed_in_at <= 72 * 3600));
    } catch (e) {
      return false;
    }
  }

  function searchName() {
    var v = form.elements.q.value.trim().replace(/\s+/g, ' ').slice(0, 60);
    // "julio rodriguez" reads better as "Julio Rodriguez"; leave other typing alone.
    if (v && v === v.toLowerCase()) v = v.replace(/(^|[\s\-'.])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    return v;
  }

  function showEmpty(searchHits, pickers) {
    var member = !alertBox || loggedIn();
    if (alertBox) alertBox.hidden = member;
    filtersBox.hidden = !member;
    if (member) return;
    var name = searchName();
    var title = alertBox.querySelector('[data-empty-title]');
    var text = alertBox.querySelector('[data-empty-text]');
    if (!name) {
      title.textContent = 'No signings match those filters.';
      text.textContent = "Try clearing one, or sign up for alerts and we'll email you as soon as a signing for your favorite players and teams pops up.";
    } else if (searchHits > 0 && pickers) {
      // There are signings for this search, just not with these pickers.
      title.textContent = 'No ' + name + ' signings match those filters.';
      text.textContent = "Try clearing one, or sign up for alerts and we'll email you the next time a " + name + ' signing pops up.';
    } else {
      title.textContent = 'No active ' + name + ' signings or meetups right now.';
      text.textContent = "Sign up for alerts and we'll email you as soon as one pops up.";
    }
    alertBox.querySelector('[data-empty-signup]').setAttribute('href', name ? signupHref + '?fav=' + encodeURIComponent(name) : signupHref);
  }

  // Logging in or out in another tab changes which message fits.
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key === 'ah-session') apply();
  });

  function apply() {
    var q = form.elements.q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var type = form.elements.type.value;
    var what = form.elements.what.value;
    var byCat = CATEGORIES.indexOf(what) !== -1;
    var state = form.elements.state.value;
    var shown = 0;
    var searchHits = 0; // cards that match the search words alone, ignoring the pickers
    // data-type is a space-separated list: a signing can be in person and mail-in.
    function hasType(c, t) { return (c.getAttribute('data-type') || '').split(' ').indexOf(t) !== -1; }
    cards.forEach(function (c) {
      var hay = c.getAttribute('data-q') || '';
      var hit = q.every(function (w) { return hay.indexOf(w) !== -1; });
      if (hit) searchHits++;
      var ok = hit &&
        (!type || hasType(c, type)) &&
        (!what || (byCat ? c.getAttribute('data-cat') === what : (c.getAttribute('data-sport') || '').toLowerCase() === what.toLowerCase())) &&
        // "Mail-in" in the state picker: mail-ins have no state, they ship anywhere.
        (!state || (state === 'mail-in' ? hasType(c, 'mail-in') : c.getAttribute('data-state') === state));
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown + (shown === 1 ? ' signing' : ' signings');
    empty.hidden = shown !== 0;
    if (shown === 0) showEmpty(searchHits, type || what || state);
    // The "Submit A Signing" card in the results steps aside when the no-results message (which has its own button) shows.
    var promo = document.querySelector('#results .promo');
    if (promo) promo.hidden = shown === 0;

    var next = new URLSearchParams();
    keys.forEach(function (k) {
      var v = form.elements[k].value.trim();
      if (v) next.set(k, v);
    });
    var qs = next.toString();
    try {
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    } catch (e) {
      // Some embedded viewers refuse address changes; filtering still works.
    }
  }

  form.addEventListener('input', apply);
  form.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
  form.addEventListener('reset', function () { setTimeout(apply, 0); });
  apply();
})();
