// Job Radar front end. Everything from data/jobs.json originates from third-party job
// boards, so it is only ever inserted with textContent / setAttribute on vetted values,
// never innerHTML.
(function () {
  'use strict';

  var FAMILY_LABELS = { 'data-eng': 'Data Eng', 'ml-eng': 'ML / AI', 'swe': 'SWE', 'data-sci': 'Data Science' };
  var TOP_SKILL_CARDS = 12;

  // ---------- tiny DOM helpers ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'text') node.textContent = String(v);
        else if (k === 'class') node.className = v;
        // CSSOM writes are allowed under the CSP; style="" attributes are not
        else if (k === 'css') Object.keys(v).forEach(function (p) { node.style.setProperty(p, v[p]); });
        else node.setAttribute(k, String(v));
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }
  function safeHref(u) {
    try {
      var url = new URL(u, location.href);
      return url.protocol === 'https:' ? url.href : null;
    } catch (e) { return null; }
  }
  function extLink(href, text, cls) {
    var h = safeHref(href);
    if (!h) return el('span', { text: text, class: cls });
    return el('a', { href: h, text: text, class: cls, target: '_blank', rel: 'noopener noreferrer' });
  }
  function dots(n) {
    var wrap = el('span', { class: 'dots', role: 'img', 'aria-label': 'self-rated ' + n + ' of 5' });
    for (var i = 1; i <= 5; i++) wrap.appendChild(el('i', { class: i <= n ? 'on' : '' }));
    return wrap;
  }
  var STATUS_TEXT = { missing: 'Missing', sharpen: 'Sharpen', maintain: 'Maintain' };
  function statusChip(status) { return el('span', { class: 'chip ' + status, text: STATUS_TEXT[status] || status }); }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function relTime(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return '';
    var days = Math.floor((Date.now() - t) / 864e5);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    return months + 'mo ago';
  }
  function fmtUpdated(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) + ' ET';
  }

  function getJson(path) {
    return fetch(path, { cache: 'no-cache', credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
      return r.json();
    });
  }

  Promise.all([getJson('data/jobs.json'), getJson('config/skills-catalog.json'), getJson('config/interview.json')])
    .then(function (res) { render(res[0], res[1], res[2]); })
    .catch(function (err) {
      var box = el('p', { class: 'load-error', text: 'Could not load today’s data (' + err.message + '). Try again in a minute.' });
      document.getElementById('jobList').appendChild(el('li', null, [box]));
    });

  function render(data, catalogFile, interview) {
    var catalog = {};
    (catalogFile.skills || []).forEach(function (s) { catalog[s.id] = s; });
    var skillName = function (id) { return catalog[id] ? catalog[id].name : id; };

    // ---------- stats ----------
    var stats = data.stats || {};
    var set = function (k, v) { var n = document.querySelector('[data-stat="' + k + '"]'); if (n) n.textContent = v; };
    set('updated', fmtUpdated(data.generatedAt));
    set('fetched', num(stats.fetched));
    set('relevant', num(stats.relevant));
    set('sponsor', num(stats.filteredOut && stats.filteredOut.sponsorship));
    document.getElementById('footUpdated').textContent = 'Data refreshed ' + fmtUpdated(data.generatedAt);

    // ---------- upskill ----------
    var demand = (data.demand || []).filter(function (d) { return catalog[d.id]; });
    var grid = document.getElementById('skillGrid');
    demand.slice(0, TOP_SKILL_CARDS).forEach(function (d) {
      var s = catalog[d.id];
      var res = el('ul', { class: 'res-list' });
      (s.resources || []).forEach(function (r) { res.appendChild(el('li', null, [extLink(r.url, r.title + ' ↗')])); });
      grid.appendChild(el('li', { class: 'skill-card' }, [
        el('h3', { text: s.name }),
        el('div', { class: 'skill-meta' }, [statusChip(d.status), el('span', { class: 'chip neutral', text: s.category })]),
        el('div', null, [
          el('div', { class: 'bar-row' }, [
            el('span', null, ['Asked for in ', el('strong', { text: d.pct + '%' }), ' of postings']),
            el('span', { text: num(d.count) + ' roles' })
          ]),
          el('div', { class: 'bar', 'aria-hidden': 'true' }, [el('span', { css: { width: Math.min(100, Math.max(2, d.pct)) + '%' } })])
        ]),
        el('div', { class: 'bar-row' }, [el('span', { text: 'My level' }), dots(d.prof)]),
        el('p', { class: 'skill-label', text: 'Free resources' }),
        res,
        el('p', { class: 'skill-label', text: 'Portfolio project' }),
        el('p', { class: 'project', text: s.project || '' })
      ]));
    });

    var more = document.getElementById('skillMore');
    var tableWrap = document.getElementById('skillTableWrap');
    var tbody = document.getElementById('skillTable');
    if (demand.length > TOP_SKILL_CARDS) {
      more.hidden = false;
      demand.slice().sort(function (a, b) { return b.pct - a.pct; }).forEach(function (d) {
        tbody.appendChild(el('tr', null, [
          el('td', { text: skillName(d.id) }),
          el('td', { text: d.pct + '% (' + num(d.count) + ')' }),
          el('td', null, [dots(d.prof)]),
          el('td', null, [statusChip(d.status)]),
          el('td', { text: String(d.priority) })
        ]));
      });
      more.addEventListener('click', function () {
        tableWrap.hidden = !tableWrap.hidden;
        more.textContent = tableWrap.hidden ? 'Show all in-demand skills' : 'Hide full skill table';
      });
    }

    // ---------- jobs ----------
    var jobs = Array.isArray(data.jobs) ? data.jobs : [];
    var citySel = document.getElementById('cityFilter');
    var cities = {};
    jobs.forEach(function (j) { (j.cities || []).forEach(function (c) { cities[c] = true; }); if (j.remote) cities['Remote (US)'] = true; });
    Object.keys(cities).sort().forEach(function (c) { citySel.appendChild(el('option', { value: c, text: c })); });

    var state = { fam: 'all', city: 'all', sort: 'match' };
    var list = document.getElementById('jobList');
    var empty = document.getElementById('emptyState');

    function jobCard(j) {
      var p = Math.max(0, Math.min(100, Number(j.match) || 0));
      var ring = el('div', { class: 'ring', role: 'img', 'aria-label': p + '% match', css: { '--p': String(p), '--ring-color': p >= 80 ? 'var(--green)' : p >= 65 ? 'var(--accent)' : 'var(--amber)' } }, [el('span', { text: p + '%' })]);

      var meta = el('div', { class: 'job-meta' }, [
        el('span', { text: j.location || '' }),
        j.posted ? el('span', { text: 'Posted ' + relTime(j.posted) }) : null,
        j.salary ? el('span', { text: j.salary }) : null,
        j.yearsRequired ? el('span', { text: j.yearsRequired + '+ yrs asked' }) : null
      ]);

      var tags = el('div', { class: 'job-tags' });
      if (j.isNew) tags.appendChild(el('span', { class: 'chip new-badge', text: 'New today' }));
      tags.appendChild(el('span', { class: 'chip accent', text: FAMILY_LABELS[j.family] || j.family }));
      tags.appendChild(el('span', { class: 'chip ' + (j.sponsorSignal === 'mentioned' ? 'maintain' : 'neutral'), text: j.sponsorSignal === 'mentioned' ? 'Sponsorship mentioned' : 'Sponsorship not stated' }));
      (j.strong || []).forEach(function (id) { tags.appendChild(el('span', { class: 'chip maintain', title: 'Strong match', text: '✓ ' + skillName(id) })); });
      (j.sharpen || []).forEach(function (id) { tags.appendChild(el('span', { class: 'chip sharpen', title: 'On my resume, needs sharpening', text: '△ ' + skillName(id) })); });
      (j.missing || []).forEach(function (id) { tags.appendChild(el('span', { class: 'chip missing', title: 'Not on my resume yet', text: '✗ ' + skillName(id) })); });

      var gd = 'https://www.glassdoor.com/Search/results.htm?keyword=' + encodeURIComponent(j.company + ' interview');
      var actions = el('div', { class: 'job-actions' }, [
        extLink(j.url, 'Apply ↗', 'apply'),
        extLink(gd, 'Interview reports ↗', 'ghost-btn')
      ]);

      return el('li', { class: 'job' }, [
        ring,
        el('div', null, [el('h3', { text: j.title }), el('div', { class: 'job-co', text: j.company }), meta, tags]),
        actions,
        prepDetails(j)
      ]);
    }

    function prepDetails(j) {
      var t = (interview.types || {})[j.companyType] || (interview.types || {}).bigtech;
      var focus = (interview.focus || {})[j.family] || [];
      var loop = el('ol');
      (t.rounds || []).forEach(function (r) { loop.appendChild(el('li', { text: r })); });
      var focusList = el('ul');
      focus.forEach(function (r) { focusList.appendChild(el('li', { text: r })); });
      (t.tips || []).forEach(function (r) { focusList.appendChild(el('li', { text: r })); });

      var gaps = (j.missing || []).concat(j.sharpen || []).slice(0, 5);
      var gapList = el('ul');
      if (gaps.length) gaps.forEach(function (id) {
        var s = catalog[id];
        var first = s && s.resources && s.resources[0];
        gapList.appendChild(el('li', null, [el('strong', { text: skillName(id) + ': ' }), first ? extLink(first.url, first.title + ' ↗') : '']));
      });
      else gapList.appendChild(el('li', { text: 'No detected gaps. Go deep on the listed skills and your project stories.' }));

      var stories = el('ul');
      (interview.stories || []).slice(0, 3).forEach(function (s) {
        stories.appendChild(el('li', null, [el('strong', { text: s.title }), ' (' + s.use + ')']));
      });

      return el('details', { class: 'prep' }, [
        el('summary', { text: 'Interview prep · ' + (t.label || '') + ' · typical timeline ' + (t.timeline || '') }),
        el('div', { class: 'prep-body' }, [
          el('div', null, [el('h4', { text: 'Typical loop' }), loop]),
          el('div', null, [el('h4', { text: 'Expect for this role' }), focusList]),
          el('div', null, [el('h4', { text: 'Close these gaps first' }), gapList]),
          el('div', null, [el('h4', { text: 'Stories to prepare' }), stories])
        ])
      ]);
    }

    function draw() {
      var rows = jobs.filter(function (j) {
        if (state.fam !== 'all' && j.family !== state.fam) return false;
        if (state.city === 'Remote (US)') return !!j.remote;
        if (state.city !== 'all' && (j.cities || []).indexOf(state.city) === -1) return false;
        return true;
      });
      if (state.sort === 'new') rows.sort(function (a, b) { return (Date.parse(b.posted) || 0) - (Date.parse(a.posted) || 0); });
      list.textContent = '';
      rows.forEach(function (j) { list.appendChild(jobCard(j)); });
      empty.hidden = rows.length > 0;
    }

    document.getElementById('famFilter').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-fam]');
      if (!b) return;
      state.fam = b.getAttribute('data-fam');
      this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      draw();
    });
    citySel.addEventListener('change', function () { state.city = citySel.value; draw(); });
    document.getElementById('sortBy').addEventListener('change', function (e) { state.sort = e.target.value; draw(); });
    draw();

    if (data.errors && data.errors.length) {
      var errs = document.getElementById('errors');
      errs.hidden = false;
      errs.textContent = 'Boards that failed on the last refresh: ' + data.errors.join('; ');
    }
  }
})();
