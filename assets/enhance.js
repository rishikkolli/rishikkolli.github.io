/* Homepage enhancements: vanilla effects, plus two small React islands
   (command palette and skills explorer). The page works fully without this file. */
(function(){
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var fine = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);

  function txt(el){ return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function slug(s){ return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function go(id){
    var el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }

  // Hero spotlight follows the cursor
  var hero = document.querySelector('.hero'), fx = document.querySelector('.hero-fx');
  if (hero && fx && fine && !reduce) {
    hero.addEventListener('pointermove', function(e){
      var r = hero.getBoundingClientRect();
      fx.style.setProperty('--mx', (e.clientX - r.left + 24) + 'px');
      fx.style.setProperty('--my', (e.clientY - r.top + 40) + 'px');
    });
  }

  // Cursor glow on cards
  if (fine) {
    document.querySelectorAll('.project-card, .footer-card').forEach(function(card){
      card.classList.add('glow');
      card.addEventListener('pointermove', function(e){
        var r = card.getBoundingClientRect();
        card.style.setProperty('--gx', (e.clientX - r.left) + 'px');
        card.style.setProperty('--gy', (e.clientY - r.top) + 'px');
      });
    });
  }

  // Highlight the nav link for the section in view
  var navLinks = {};
  document.querySelectorAll('nav.links a[href^="#"]').forEach(function(a){ navLinks[a.getAttribute('href').slice(1)] = a; });
  if ('IntersectionObserver' in window) {
    var nio = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (!en.isIntersecting || !navLinks[en.target.id]) return;
        Object.keys(navLinks).forEach(function(k){ navLinks[k].classList.remove('active'); });
        navLinks[en.target.id].classList.add('active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(navLinks).forEach(function(id){ var s = document.getElementById(id); if (s) nio.observe(s); });
  }

  // ---------- React islands ----------
  if (!window.React || !window.ReactDOM || !window.htm) return;
  var h = React.createElement, html = htm.bind(h);
  var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo, useRef = React.useRef;

  // Index roles and projects (with their tags) straight from the page
  var places = [];
  document.querySelectorAll('.role[id]').forEach(function(el){
    places.push({
      id: el.id, kind: 'Role',
      title: txt(el.querySelector('.role-title')), sub: txt(el.querySelector('.role-org')),
      when: txt(el.querySelector('.role-when')).replace('CURRENT', '').trim(),
      tags: Array.prototype.map.call(el.querySelectorAll('.tag'), txt)
    });
  });
  document.querySelectorAll('.project-card').forEach(function(el){
    var t = txt(el.querySelector('h3'));
    if (!el.id) el.id = 'project-' + slug(t);
    places.push({
      id: el.id, kind: 'Project',
      title: t, sub: txt(el.querySelector('.project-sub')), when: txt(el.querySelector('.project-year')),
      tags: Array.prototype.map.call(el.querySelectorAll('.tag'), txt)
    });
  });

  // ----- Command palette -----
  function score(q, s){
    q = q.toLowerCase(); s = (s || '').toLowerCase();
    var i = s.indexOf(q);
    if (i >= 0) return 100 - Math.min(i, 60);
    var j = 0, gaps = 0;
    for (var k = 0; k < s.length && j < q.length; k++) { if (s[k] === q[j]) j++; else if (j) gaps++; }
    return j === q.length ? Math.max(1, 30 - gaps) : 0;
  }

  function buildItems(){
    var items = [];
    Object.keys(navLinks).forEach(function(id){
      items.push({ group: 'Jump to', label: txt(navLinks[id]), hint: 'Section', run: function(){ go(id); } });
    });
    places.forEach(function(p){
      items.push({ group: p.kind === 'Role' ? 'Experience' : 'Projects', label: p.title, hint: p.sub, keys: p.tags.join(' '), run: function(){ go(p.id); } });
    });
    items.push({ group: 'Actions', label: 'Copy email address', hint: 'rishikkolli@gmail.com', run: function(){
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText('rishikkolli@gmail.com').catch(function(){});
    } });
    items.push({ group: 'Actions', label: 'Send an email', hint: 'Opens your mail app', run: function(){ location.href = 'mailto:rishikkolli@gmail.com'; } });
    items.push({ group: 'Actions', label: 'Toggle light / dark theme', hint: 'Theme', run: function(){ var b = document.getElementById('themeToggle'); if (b) b.click(); } });
    items.push({ group: 'Links', label: 'LinkedIn', hint: 'linkedin.com/in/rishikkolli', run: function(){ window.open('https://www.linkedin.com/in/rishikkolli/', '_blank', 'noopener'); } });
    items.push({ group: 'Links', label: 'GitHub', hint: 'github.com/rishikkolli', run: function(){ window.open('https://github.com/rishikkolli', '_blank', 'noopener'); } });
    return items;
  }

  function Palette(){
    var items = useMemo(buildItems, []);
    var openState = useState(false), open = openState[0], setOpen = openState[1];
    var qState = useState(''), q = qState[0], setQ = qState[1];
    var selState = useState(0), sel = selState[0], setSel = selState[1];
    var inputRef = useRef(null), listRef = useRef(null), lastFocus = useRef(null), mounted = useRef(false);

    useEffect(function(){
      function onKey(e){
        var tag = (e.target && e.target.tagName) || '';
        if ((e.metaKey || e.ctrlKey) && (e.key || '').toLowerCase() === 'k') { e.preventDefault(); setOpen(function(o){ return !o; }); }
        else if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) { e.preventDefault(); setOpen(true); }
      }
      function onOpen(){ setOpen(true); }
      window.addEventListener('keydown', onKey);
      window.addEventListener('cmdk:open', onOpen);
      return function(){ window.removeEventListener('keydown', onKey); window.removeEventListener('cmdk:open', onOpen); };
    }, []);

    useEffect(function(){
      if (!mounted.current) { mounted.current = true; return; }
      if (open) {
        lastFocus.current = document.activeElement;
        setQ(''); setSel(0);
        document.body.style.overflow = 'hidden';
        setTimeout(function(){ if (inputRef.current) inputRef.current.focus(); }, 0);
      } else {
        document.body.style.overflow = '';
        if (lastFocus.current && lastFocus.current.focus) lastFocus.current.focus();
      }
    }, [open]);

    var results = useMemo(function(){
      var query = q.trim();
      if (!query) return items;
      return items.map(function(it){
        return { it: it, s: Math.max(score(query, it.label), score(query, it.hint) * 0.6, score(query, it.keys) * 0.5) };
      }).filter(function(x){ return x.s > 0; })
        .sort(function(a, b){ return b.s - a.s; })
        .map(function(x){ return x.it; });
    }, [q, items]);

    useEffect(function(){ setSel(0); }, [q]);
    useEffect(function(){
      var el = listRef.current && listRef.current.querySelector('[aria-selected="true"]');
      if (el) el.scrollIntoView({ block: 'nearest' });
    }, [sel, open]);

    function choose(it){ setOpen(false); setTimeout(it.run, 20); }
    function onKeyDown(e){
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(function(s){ return Math.min(s + 1, results.length - 1); }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(function(s){ return Math.max(s - 1, 0); }); }
      else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) choose(results[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    }

    if (!open) return null;
    var rows = [], last = null, grouped = !q.trim();
    results.forEach(function(it, i){
      if (grouped && it.group !== last) { rows.push(html`<div class="cmdk-group" key=${'g-' + it.group}>${it.group}</div>`); last = it.group; }
      rows.push(html`<button type="button" role="option" class="cmdk-item" key=${it.group + i}
        aria-selected=${i === sel ? 'true' : 'false'}
        onMouseMove=${function(){ if (sel !== i) setSel(i); }}
        onClick=${function(){ choose(it); }}>
        <span>${it.label}</span><small>${grouped ? it.hint : it.group + ' · ' + it.hint}</small>
      </button>`);
    });

    return html`<div class="cmdk-overlay" onMouseDown=${function(e){ if (e.target === e.currentTarget) setOpen(false); }}>
      <div class="cmdk" role="dialog" aria-modal="true" aria-label="Command menu">
        <input ref=${inputRef} value=${q} onChange=${function(e){ setQ(e.target.value); }} onKeyDown=${onKeyDown}
          placeholder="Search roles, projects, skills, or actions…" aria-label="Search the site"
          role="combobox" aria-expanded="true" aria-controls="cmdk-list" autoComplete="off" spellCheck="false" />
        <div class="cmdk-list" id="cmdk-list" role="listbox" ref=${listRef}>
          ${rows.length ? rows : html`<div class="cmdk-empty">No matches for “${q}”</div>`}
        </div>
        <div class="cmdk-foot"><span>↑ ↓ move</span><span>↵ open</span><span>esc close</span></div>
      </div>
    </div>`;
  }

  // ----- Skills explorer -----
  function termOf(skill){
    var t = skill.split('·').pop().trim();
    if (t === 'C / C++') return 'C++';
    if (/^Looker/.test(t)) return 'Looker';
    return t;
  }
  var usageCache = {};
  function usedIn(skill){
    if (usageCache[skill]) return usageCache[skill];
    var term = termOf(skill).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var re = new RegExp('(^|[^a-z0-9+#])' + term + '($|[^a-z0-9+#])', 'i');
    return (usageCache[skill] = places.filter(function(p){ return p.tags.some(function(tag){ return re.test(tag); }); }));
  }

  function Skills(props){
    var st = useState(null), active = st[0], setActive = st[1];
    return html`<${React.Fragment}>
      <p class="sx-hint">Select a skill to see where I've used it.</p>
      ${props.groups.map(function(g){
        var interactive = !/certif/i.test(g.name);
        var showPanel = active && g.skills.indexOf(active) >= 0;
        var hits = showPanel ? usedIn(active) : [];
        return html`<div class="skill-group" key=${g.name}>
          <div class="skill-group-name">${g.name}</div>
          <div class="tags">
            ${g.skills.map(function(s){
              if (!interactive) return html`<span class="tag" key=${s}>${s}</span>`;
              var n = usedIn(s).length;
              return html`<button type="button" key=${s} class="tag sx-chip" aria-pressed=${active === s ? 'true' : 'false'}
                onClick=${function(){ setActive(active === s ? null : s); }}>${s}${n ? html`<span class="sx-count">${n}</span>` : null}</button>`;
            })}
          </div>
          ${showPanel && html`<div class="sx-panel" role="region" aria-live="polite">
            <h4>${active}</h4>
            ${hits.length
              ? html`<ul>${hits.map(function(p){
                  return html`<li key=${p.id}><a href=${'#' + p.id} onClick=${function(e){ e.preventDefault(); go(p.id); }}>
                    <span>${p.title} <span class="sx-sub">· ${p.sub}</span></span><small>${p.when}</small></a></li>`;
                })}</ul>`
              : html`<p class="sx-none">Not tagged on a role or project on this page yet.</p>`}
          </div>`}
        </div>`;
      })}
    <//>`;
  }

  var sg = document.querySelector('.skill-groups');
  if (sg) {
    var groups = Array.prototype.map.call(sg.querySelectorAll('.skill-group'), function(g){
      return { name: txt(g.querySelector('.skill-group-name')), skills: Array.prototype.map.call(g.querySelectorAll('.tag'), txt) };
    });
    ReactDOM.createRoot(sg).render(html`<${Skills} groups=${groups} />`);
  }

  var root = document.getElementById('cmdk-root');
  if (root) ReactDOM.createRoot(root).render(html`<${Palette} />`);
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  document.querySelectorAll('.cmdk-btn').forEach(function(btn){
    btn.hidden = false;
    var k = btn.querySelector('kbd'); if (k) k.textContent = isMac ? '⌘K' : 'Ctrl K';
    btn.addEventListener('click', function(){ window.dispatchEvent(new Event('cmdk:open')); });
  });
})();
