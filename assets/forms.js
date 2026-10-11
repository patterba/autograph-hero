// Sends the "Submit a signing" and "Get alerts" forms to the site-forms Supabase function.
// The JSON goes as text/plain so the browser doesn't need a CORS preflight.
(function () {
  var forms = document.querySelectorAll('form[data-form]');
  Array.prototype.forEach.call(forms, setup);

  function setup(form) {
    var kind = form.getAttribute('data-form');
    var started = Date.now();
    var status = form.querySelector('.f-status');
    var button = form.querySelector('button[type="submit"]');
    var favorites = [];
    var favInput = form.querySelector('#s-fav');
    var favList = form.querySelector('[data-fav-list]');

    if (favInput) {
      var params = new URLSearchParams(location.search);
      params.getAll('fav').forEach(addFavorite);
      form.querySelector('[data-fav-add]').addEventListener('click', function () {
        addFavorite(favInput.value);
        favInput.focus();
      });
      favInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addFavorite(favInput.value);
        }
      });
    }

    function addFavorite(value) {
      var v = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!v) return;
      var exists = favorites.some(function (f) { return f.toLowerCase() === v.toLowerCase(); });
      if (!exists && favorites.length < 25) favorites.push(v);
      if (favInput) favInput.value = '';
      renderFavorites();
    }

    function renderFavorites() {
      if (!favList) return;
      favList.textContent = '';
      favorites.forEach(function (f, i) {
        var li = document.createElement('li');
        var span = document.createElement('span');
        span.textContent = f;
        var remove = document.createElement('button');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remove ' + f);
        remove.textContent = '×';
        remove.addEventListener('click', function () {
          favorites.splice(i, 1);
          renderFavorites();
          if (favInput) favInput.focus();
        });
        li.appendChild(span);
        li.appendChild(remove);
        favList.appendChild(li);
      });
    }

    function show(message, kindOfMessage) {
      status.hidden = false;
      status.className = 'f-status ' + (kindOfMessage || '');
      status.textContent = message;
    }

    function invalid(el, message) {
      if (el) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
      }
      show(message, 'is-error');
      return false;
    }

    function value(name) {
      var el = form.elements[name];
      if (!el) return '';
      if (el.length !== undefined && el.tagName !== 'SELECT') {
        for (var i = 0; i < el.length; i++) if (el[i].checked) return el[i].value;
        return '';
      }
      if (el.type === 'checkbox') return el.checked;
      return String(el.value || '').trim();
    }

    function validate() {
      Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (el) { el.removeAttribute('aria-invalid'); });
      var email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (kind === 'listing') {
        if (!value('athlete_names')) return invalid(form.elements.athlete_names, 'Please enter who is signing.');
        if (!value('signing_type')) return invalid(form.querySelector('input[name="signing_type"]'), 'Please choose how the signing works.');
        if (!value('event_date') && !value('order_deadline')) return invalid(form.elements.event_date, 'Please enter the signing date or the order deadline.');
        if (!/^https?:\/\/\S+\.\S+/.test(value('source_url'))) return invalid(form.elements.source_url, 'Please add a link to the official announcement or order page, starting with https://');
        if (!email.test(value('submitter_email'))) return invalid(form.elements.submitter_email, 'Please enter a valid email address so we can follow up.');
      } else {
        if (favInput && favInput.value.trim()) addFavorite(favInput.value);
        if (!value('name')) return invalid(form.elements.name, 'Please enter your name.');
        if (!email.test(value('email'))) return invalid(form.elements.email, 'Please enter a valid email address.');
        if (!favorites.length) return invalid(favInput, 'Please add at least one favorite team, player or person.');
        if (!value('consent')) return invalid(form.elements.consent, 'Please tick the box to agree to receive alert emails.');
      }
      return true;
    }

    function payload() {
      var data = { form: kind, elapsed_ms: Date.now() - started, website: value('website') };
      if (kind === 'listing') {
        ['signing_type', 'sport', 'event_date', 'event_time_text', 'order_deadline', 'venue', 'city', 'state', 'source_url', 'price_text', 'notes', 'submitter_name', 'submitter_email']
          .forEach(function (k) { data[k] = value(k) || null; });
        data.athlete_names = value('athlete_names').split(',').map(function (n) { return n.trim(); }).filter(Boolean);
      } else {
        data.name = value('name');
        data.email = value('email');
        data.consent = value('consent') === true;
        data.favorites = favorites.slice();
      }
      return data;
    }

    form.addEventListener('input', function (e) {
      if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validate()) return;
      button.disabled = true;
      show('Sending…', '');
      fetch(form.getAttribute('data-endpoint'), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload()),
      })
        .then(function (res) {
          return res.json().catch(function () { return { ok: false }; });
        })
        .then(function (r) {
          if (r && r.ok) {
            form.reset();
            favorites = [];
            renderFavorites();
            started = Date.now();
            show(r.message || 'Thanks! We got it.', 'is-success');
          } else {
            show((r && r.message) || 'Something went wrong. Please try again in a minute.', 'is-error');
          }
        })
        .catch(function () {
          show("We couldn't reach the server. Check your connection and try again.", 'is-error');
        })
        .then(function () {
          button.disabled = false;
          status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
    });
  }
})();
