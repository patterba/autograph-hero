// Filters the cards on the "All signings" page. The page works without this
// script (every signing is in the HTML); this only narrows what is shown.
(function () {
  var form = document.getElementById('filters');
  if (!form) return;
  var cards = Array.prototype.slice.call(document.querySelectorAll('#results .card'));
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var keys = ['q', 'type', 'sport', 'state'];

  // Start from the address bar, so links like /events/?sport=Football work.
  var params = new URLSearchParams(location.search);
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

  // No results for a search: invite the fan to get alerts for what they searched
  // (Sign Up with it filled in as a favorite). No search words: the plain message.
  var searchBox = empty.querySelector('[data-empty="search"]');
  var filtersBox = empty.querySelector('[data-empty="filters"]');
  var signupHref = searchBox ? searchBox.querySelector('[data-empty-signup]').getAttribute('href') : '';

  function searchName() {
    var v = form.elements.q.value.trim().replace(/\s+/g, ' ').slice(0, 60);
    // "julio rodriguez" reads better as "Julio Rodriguez"; leave other typing alone.
    if (v && v === v.toLowerCase()) v = v.replace(/(^|[\s\-'.])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    return v;
  }

  function showEmpty(searchHits, pickers) {
    var name = searchName();
    if (!searchBox || !name) {
      if (searchBox) searchBox.hidden = true;
      filtersBox.hidden = false;
      return;
    }
    searchBox.hidden = false;
    filtersBox.hidden = true;
    var title = searchBox.querySelector('[data-empty-title]');
    var text = searchBox.querySelector('[data-empty-text]');
    if (searchHits > 0 && pickers) {
      // There are signings for this search, just not with these pickers.
      title.textContent = 'No ' + name + ' signings match those filters.';
      text.textContent = "Try clearing one, or sign up for alerts and we'll email you as soon as a new one pops up.";
    } else {
      title.textContent = 'No active ' + name + ' signings or meetups right now.';
      text.textContent = "Sign up for alerts and we'll email you as soon as one pops up.";
    }
    searchBox.querySelector('[data-empty-signup]').setAttribute('href', signupHref + '?fav=' + encodeURIComponent(name));
  }

  function apply() {
    var q = form.elements.q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var type = form.elements.type.value;
    var sport = form.elements.sport.value;
    var state = form.elements.state.value;
    var shown = 0;
    var searchHits = 0; // cards that match the search words alone, ignoring the pickers
    cards.forEach(function (c) {
      var hay = c.getAttribute('data-q') || '';
      var hit = q.every(function (w) { return hay.indexOf(w) !== -1; });
      if (hit) searchHits++;
      var ok = hit &&
        (!type || c.getAttribute('data-type') === type) &&
        (!sport || c.getAttribute('data-sport') === sport) &&
        // "Mail-in" in the state picker: mail-ins have no state, they ship anywhere.
        (!state || (state === 'mail-in' ? c.getAttribute('data-type') === 'mail-in' : c.getAttribute('data-state') === state));
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown + (shown === 1 ? ' signing' : ' signings');
    empty.hidden = shown !== 0;
    if (shown === 0) showEmpty(searchHits, type || sport || state);
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
