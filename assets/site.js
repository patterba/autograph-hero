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

  function apply() {
    var q = form.elements.q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    var type = form.elements.type.value;
    var sport = form.elements.sport.value;
    var state = form.elements.state.value;
    var shown = 0;
    cards.forEach(function (c) {
      var hay = c.getAttribute('data-q') || '';
      var ok = q.every(function (w) { return hay.indexOf(w) !== -1; }) &&
        (!type || c.getAttribute('data-type') === type) &&
        (!sport || c.getAttribute('data-sport') === sport) &&
        (!state || c.getAttribute('data-state') === state);
      c.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown + (shown === 1 ? ' signing' : ' signings');
    empty.hidden = shown !== 0;

    var next = new URLSearchParams();
    keys.forEach(function (k) {
      var v = form.elements[k].value.trim();
      if (v) next.set(k, v);
    });
    var qs = next.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  form.addEventListener('input', apply);
  form.addEventListener('submit', function (e) { e.preventDefault(); apply(); });
  form.addEventListener('reset', function () { setTimeout(apply, 0); });
  apply();
})();
