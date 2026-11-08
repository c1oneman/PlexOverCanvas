// Canvas: a Plex client that plays through JSMpeg onto a <canvas>.
// Views are rendered from the URL hash: #/ (home), #/library/<key>,
// #/item/<key>, #/search/<query>. The player is an overlay on top.
(function () {
  'use strict';

  // ============================================================
  // Helpers
  // ============================================================
  var $ = function (id) { return document.getElementById(id); };

  // h('div.card', { onclick: fn }, child, 'text', [more]) -> element
  function h(tag, attrs) {
    var parts = tag.split('.');
    var el = document.createElement(parts[0] || 'div');
    if (parts.length > 1) el.className = parts.slice(1).join(' ');
    var kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (attrs.nodeType || typeof attrs !== 'object' || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
    for (var k in attrs || {}) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    (function add(list) {
      list.forEach(function (c) {
        if (c == null || c === false) return;
        if (Array.isArray(c)) add(c);
        else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
      });
    })(kids);
    return el;
  }

  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    unfull: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    check: '<svg class="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    tick: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  };
  // Replaces el's children, with the same child rules as h() (arrays, nulls).
  function fill(el) {
    var tmp = h.apply(null, ['div', null].concat(Array.prototype.slice.call(arguments, 1)));
    el.replaceChildren.apply(el, Array.prototype.slice.call(tmp.childNodes));
    return el;
  }

  function icon(name) { return h('span', { html: ICON[name], style: { display: 'contents' } }); }

  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || 'Request failed (' + r.status + ')'); e.status = r.status; throw e; }
        return j;
      });
    });
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var hr = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return (hr ? hr + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function fmtDuration(ms) {
    var m = Math.round(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function epCode(it) { return 'S' + it.parentIndex + ' · E' + it.index; }

  function thumb(path, w, hgt) {
    return path ? '/api/plex/thumb?path=' + encodeURIComponent(path) + '&w=' + w + '&h=' + hgt : '';
  }

  function img(src, alt) {
    if (!src) return null;
    var el = h('img', { src: src, alt: alt || '', loading: 'lazy', decoding: 'async' });
    el.onload = function () { el.classList.add('ok'); };
    el.onerror = function () { el.remove(); };
    return el;
  }

  var toastTimer = null;
  function toast(msg, isErr) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  var prefs = { quality: 'auto', mode: 'muxed', volume: 1, muted: false, v: 2 };
  try {
    var saved = JSON.parse(localStorage.getItem('canvasPrefs') || '{}');
    if (!saved.v) delete saved.quality; // v1 saved a fixed 480p default; switch those to auto
    Object.assign(prefs, saved, { v: 2 });
  } catch (e) {}
  function savePrefs() { try { localStorage.setItem('canvasPrefs', JSON.stringify(prefs)); } catch (e) {} }

  // ============================================================
  // Session
  // ============================================================
  var me = null, servers = [], libs = [];

  function boot() {
    return api('/api/plex/me').then(function (m) {
      me = m;
      if (!m.signedIn) return showSignin(m.error);
      return api('/api/plex/servers').then(function (list) {
        servers = list;
        if (!list.length) throw new Error('No Plex servers on this account.');
        var pick = list.some(function (s) { return s.id === m.serverId; }) ? m.serverId : list[0].id;
        return selectServer(pick, true);
      });
    }).catch(function (e) {
      if (e.status === 401) return showSignin();
      showShell();
      $('view').replaceChildren(h('div.empty', e.message));
    });
  }

  function selectServer(id, initial) {
    return api('/api/plex/server', { method: 'POST', body: { id: id } }).then(function () {
      me.serverId = id;
      return api('/api/plex/libraries');
    }).then(function (l) {
      libs = l;
      if (!cachedBandwidth()) measureBandwidth(512).catch(function () {});
      showShell();
      renderNav();
      if (!initial) location.hash = '#/';
      route();
    });
  }

  function showSignin(err) {
    $('shell').hidden = true;
    $('signin').hidden = false;
    $('signinWait').hidden = true;
    $('signinErr').hidden = !err;
    $('signinErr').textContent = err || '';
  }

  function showShell() {
    $('signin').hidden = true;
    $('shell').hidden = false;
    var av = $('avatar');
    av.replaceChildren(me.user && me.user.thumb ? h('img', { src: me.user.thumb, alt: '' }) : (me.user ? me.user.username[0].toUpperCase() : '?'));
  }

  $('btnLogin').onclick = function () {
    // Open the window inside the click so popup blockers allow it.
    var win = window.open('', 'plexauth', 'width=600,height=720');
    $('signinErr').hidden = true;
    $('signinWait').hidden = false;
    api('/api/plex/pin', { method: 'POST' }).then(function (r) {
      if (!win) { location.href = r.authUrl; return; }
      win.location = r.authUrl;
      var tries = 0;
      var poll = setInterval(function () {
        if (++tries > 200) { clearInterval(poll); showSignin('Sign-in timed out. Try again.'); return; }
        api('/api/plex/pin').then(function (p) {
          if (!p.done && !p.error) return;
          clearInterval(poll);
          try { win.close(); } catch (e) {}
          if (p.error) showSignin(p.error); else boot();
        }).catch(function () {});
      }, 1500);
    }).catch(function (e) { try { win && win.close(); } catch (x) {} showSignin(e.message); });
  };

  // Account menu
  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  document.addEventListener('click', function (e) {
    if (openMenu && !openMenu.contains(e.target) && e.target !== $('avatar') && !$('avatar').contains(e.target)) closeMenu();
  });

  $('avatar').onclick = function () {
    if (openMenu) return closeMenu();
    var r = this.getBoundingClientRect();
    var m = h('div.menu', { style: { top: (r.bottom + 8) + 'px', right: (window.innerWidth - r.right) + 'px', position: 'fixed' } },
      h('div.menu-user', h('b', me.user ? me.user.username : ''), h('span', 'Plex account')),
      h('div.menu-sep'),
      servers.length > 1 ? [h('div.menu-label', 'Server'), servers.map(function (s) {
        return h('button.menu-item', { onclick: function () { closeMenu(); selectServer(s.id); } },
          s.name + (s.owned ? '' : ' (shared)'), s.id === me.serverId ? h('span', { html: ICON.check, style: { display: 'contents' } }) : null);
      }), h('div.menu-sep')] : null,
      h('a.menu-item', { href: '/bench/' }, 'Benchmark'),
      h('a.menu-item', { href: '/probe/' }, 'Browser probe'),
      h('button.menu-item', { onclick: function () { closeMenu(); api('/api/plex/logout', { method: 'POST' }).then(function () { location.hash = '#/'; boot(); }); } }, 'Sign out'));
    document.body.appendChild(m);
    openMenu = m;
  };

  // ============================================================
  // Router
  // ============================================================
  var routeToken = 0;

  function renderNav() {
    var hash = location.hash || '#/';
    var links = [h('a', { href: '#/', class: hash === '#/' ? 'on' : null }, 'Home')].concat(libs.map(function (l) {
      return h('a', { href: '#/library/' + l.key, class: hash === '#/library/' + l.key ? 'on' : null }, l.title);
    }));
    $('nav').replaceChildren.apply($('nav'), links);
  }

  function route(keepScroll) {
    if ($('shell').hidden) return;
    if (keepScroll && keepScroll.type) keepScroll = false; // called as an event handler
    var hash = location.hash || '#/';
    var token = ++routeToken;
    var stale = function () { return token !== routeToken; };
    renderNav();
    closeMenu();
    if (!keepScroll) window.scrollTo(0, 0);
    var m;
    if ((m = /^#\/library\/(\d+)/.exec(hash))) return libraryView(m[1], stale);
    if ((m = /^#\/item\/(\d+)/.exec(hash))) return itemView(m[1], stale);
    if ((m = /^#\/search\/(.*)$/.exec(hash))) return searchView(decodeURIComponent(m[1]), stale);
    homeView(stale);
  }
  window.addEventListener('hashchange', route);

  function fail(e) { $('view').replaceChildren(h('div.empty', e.message)); }

  // ============================================================
  // Cards
  // ============================================================
  function card(it, opts) {
    opts = opts || {};
    var wide = !!opts.wide;
    var path = wide ? (it.type === 'episode' ? it.thumb : it.art || it.thumb) : (it.type === 'episode' ? it.grandparentThumb || it.thumb : it.thumb);
    var src = wide ? thumb(path, 480, 270) : thumb(path, 300, 450);
    var title = it.type === 'episode' ? it.grandparentTitle : it.type === 'season' ? it.parentTitle || it.title : it.title;
    var sub = it.type === 'episode' ? epCode(it) + ' · ' + it.title
      : it.type === 'season' ? it.title
      : it.type === 'show' ? (it.childCount ? it.childCount + ' season' + (it.childCount > 1 ? 's' : '') : (it.leafCount || 0) + ' episodes')
      : it.year || '';
    var unwatched = it.type === 'show' || it.type === 'season' ? (it.leafCount || 0) - (it.viewedLeafCount || 0) : 0;
    var progress = it.viewOffset && it.duration ? Math.min(100, 100 * it.viewOffset / it.duration) : 0;
    return h('button.card' + (wide ? '.wide' : ''), {
      title: title,
      onclick: function () {
        if (opts.play && it.playable) playItem(it, it.viewOffset ? it.viewOffset / 1000 : 0);
        else location.hash = '#/item/' + it.key;
      },
    },
      h('div.art',
        h('div.ph', title),
        img(src, title),
        unwatched > 0 ? h('span.badge', unwatched) : null,
        it.viewCount && !progress && it.playable ? h('span.badge', { html: ICON.tick }) : null,
        progress ? h('div.prog', h('i', { style: { width: progress + '%' } })) : null,
        h('div.hover', h('span', { html: it.playable ? ICON.play : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>' }))),
      h('div.t', title),
      h('div.s', sub || ' '));
  }

  function skeletonRail(wide) {
    var r = h('div.rail' + (wide ? '.wide' : ''));
    for (var i = 0; i < 8; i++) r.appendChild(h('div', h('div.skel', { style: { aspectRatio: wide ? '16/9' : '2/3' } })));
    return r;
  }

  // ============================================================
  // Home
  // ============================================================
  function homeView(stale) {
    $('view').replaceChildren(
      h('div', { style: { height: '28px' } }),
      h('section.row', h('h2', 'Continue Watching'), skeletonRail(true)),
      h('section.row', h('h2', 'Recently Added'), skeletonRail(false)));
    api('/api/plex/home').then(function (d) {
      if (stale()) return;
      var nodes = [];
      var feat = d.onDeck[0];
      if (feat) nodes.push(heroBlock(feat, { featured: true }));
      else nodes.push(h('div', { style: { height: '28px' } }));
      if (d.onDeck.length > 1 || (!feat && d.onDeck.length)) {
        nodes.push(h('section.row', h('h2', 'Continue Watching'),
          h('div.rail.wide', d.onDeck.slice(feat ? 1 : 0).map(function (it) { return card(it, { wide: true, play: true }); }))));
      }
      if (d.recent.length) {
        nodes.push(h('section.row', h('h2', 'Recently Added'),
          h('div.rail', d.recent.map(function (it) { return card(it); }))));
      }
      if (!d.onDeck.length && !d.recent.length) nodes.push(h('div.empty', 'Nothing here yet. Pick a library above.'));
      $('view').replaceChildren.apply($('view'), nodes);
    }).catch(fail);
  }

  // ============================================================
  // Library
  // ============================================================
  function libraryView(key, stale) {
    var lib = libs.find(function (l) { return l.key === key; }) || { title: 'Library' };
    var grid = h('div.grid');
    var count = h('span.count');
    var more = h('div.more');
    var filter = h('input.filter', { type: 'search', placeholder: 'Filter ' + lib.title.toLowerCase(), 'aria-label': 'Filter' });
    var loaded = 0, total = 0, q = '', timer = null;

    function load(reset) {
      if (reset) {
        loaded = 0;
        grid.replaceChildren();
        for (var i = 0; i < 12; i++) grid.appendChild(h('div', h('div.skel', { style: { aspectRatio: '2/3' } })));
      }
      var mine = q;
      api('/api/plex/library/' + key + '?start=' + loaded + '&title=' + encodeURIComponent(q)).then(function (r) {
        if (stale() || mine !== q) return;
        if (!loaded) grid.replaceChildren();
        r.items.forEach(function (it) { grid.appendChild(card(it)); });
        loaded += r.items.length;
        total = r.total;
        count.textContent = total + (total === 1 ? ' title' : ' titles');
        fill(more, loaded < total ? h('button.btn.btn-ghost', { onclick: function () { this.disabled = true; load(false); } }, 'Load more') : null);
        if (!total) grid.replaceChildren(h('div.empty', { style: { gridColumn: '1 / -1' } }, q ? 'No matches for “' + q + '”.' : 'This library is empty.'));
      }).catch(fail);
    }

    filter.oninput = function () { clearTimeout(timer); timer = setTimeout(function () { q = filter.value.trim(); load(true); }, 250); };
    $('view').replaceChildren(h('div.page', h('div.page-head', h('h1', lib.title), count, filter), grid, more));
    load(true);
  }

  // ============================================================
  // Search
  // ============================================================
  var searchTimer = null;
  $('search').oninput = function () {
    var v = this.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { location.hash = v ? '#/search/' + encodeURIComponent(v) : '#/'; }, 300);
  };

  function searchView(q, stale) {
    if ($('search').value.trim() !== q) $('search').value = q;
    var grid = h('div.grid');
    $('view').replaceChildren(h('div.page', h('div.page-head', h('h1', 'Results for “' + q + '”')), grid));
    api('/api/plex/search?q=' + encodeURIComponent(q)).then(function (items) {
      if (stale()) return;
      grid.replaceChildren.apply(grid, items.length ? items.map(function (it) { return card(it); }) : [h('div.empty', { style: { gridColumn: '1 / -1' } }, 'Nothing found.')]);
    }).catch(fail);
  }

  // ============================================================
  // Detail
  // ============================================================
  // Hero for a movie, show or episode. opts.featured makes it the home banner.
  function heroBlock(it, opts) {
    opts = opts || {};
    var bg = h('div.hero-bg');
    var art = it.art ? thumb(it.art, 1600, 900) : '';
    if (art) {
      var pre = new Image();
      pre.onload = function () { bg.style.backgroundImage = 'url("' + art + '")'; bg.classList.add('ok'); };
      pre.src = art;
    }
    var isEp = it.type === 'episode';
    // The home banner shows the show's poster; an episode page shows its still.
    var wideStill = isEp && !opts.featured;
    var posterSrc = wideStill ? thumb(it.thumb, 640, 360) : thumb(isEp ? it.grandparentThumb : it.thumb, 420, 630);
    var meta = [];
    if (isEp) meta.push(epCode(it));
    if (it.year) meta.push(it.year);
    if (it.contentRating) meta.push(h('span.pill', it.contentRating));
    if (it.duration && it.playable) meta.push(fmtDuration(it.duration));
    if (it.type === 'show' && it.childCount) meta.push(it.childCount + ' season' + (it.childCount > 1 ? 's' : ''));
    if (it.rating) meta.push('★ ' + Number(it.rating).toFixed(1));
    if (it.resolution) meta.push(h('span.pill', /^\d+$/.test(it.resolution) ? it.resolution + 'p' : it.resolution.toUpperCase()));
    if (it.genres && it.genres.length) meta.push(it.genres.join(', '));

    var actions = h('div.actions');
    if (it.playable) {
      if (it.viewOffset) {
        actions.append(
          h('button.btn.btn-primary', { onclick: function () { playItem(it, it.viewOffset / 1000); } }, icon('play'), 'Resume'),
          h('button.btn.btn-ghost', { onclick: function () { playItem(it, 0); } }, 'Play from start'),
          h('span.resume-note', fmtTime((it.duration - it.viewOffset) / 1000) + ' left'));
      } else {
        actions.append(h('button.btn.btn-primary', { onclick: function () { playItem(it, 0); } }, icon('play'), 'Play'));
      }
    }
    if (opts.featured) actions.append(h('a.btn.btn-ghost', { href: '#/item/' + (isEp ? it.grandparentKey : it.key) }, 'Details'));
    if (opts.actions) actions.append(opts.actions);

    var summary = it.summary ? h('p.summary', { onclick: function () { this.classList.toggle('open'); } }, it.summary) : null;
    var eyebrow = opts.featured ? h('div.eyebrow', 'Continue watching')
      : isEp ? h('div.eyebrow', h('a', { href: '#/item/' + it.grandparentKey }, it.grandparentTitle))
      : null;

    return h('section.hero', bg,
      h('div.hero-inner',
        h('div.hero-poster' + (wideStill ? '.wide' : ''), img(posterSrc, '')),
        h('div',
          eyebrow,
          h('h1', opts.featured && isEp ? it.grandparentTitle : it.title),
          opts.featured && isEp ? h('div.meta', epCode(it) + ' · ' + it.title)
            : h('div.meta', meta.map(function (m) { return typeof m === 'object' ? m : h('span', m); })),
          !opts.featured && it.tagline ? h('div.tagline', it.tagline) : null,
          summary,
          actions)));
  }

  function itemView(key, stale) {
    $('view').replaceChildren(h('section.hero', h('div.hero-inner', h('div.hero-poster.skel'))));
    api('/api/plex/item/' + key).then(function (it) {
      if (stale()) return;
      // Seasons open on their show with that season selected.
      if (it.type === 'season') return showView(it.parentKey, it.key, null, stale);
      if (it.type === 'show') return showView(it.key, null, it, stale);
      if (it.type === 'episode') return showView(it.grandparentKey, it.parentKey, null, stale, it);
      $('view').replaceChildren(heroBlock(it));
    }).catch(fail);
  }

  // A show page: hero (the show, or an episode if one was opened), season
  // pills and the selected season's episodes.
  function showView(showKey, seasonKey, show, stale, episode) {
    var showReq = show ? Promise.resolve(show) : api('/api/plex/item/' + showKey);
    showReq.then(function (sh) {
      if (stale()) return;
      var seasons = sh.children || [];
      var sel = seasons.find(function (s) { return s.key === seasonKey; }) ||
        seasons.find(function (s) { return (s.viewedLeafCount || 0) < (s.leafCount || 0); }) || seasons[0];
      var list = h('div.episodes');
      var pills = h('div.seasons');
      var heroSlot = h('div');
      var playNext = h('span');

      function renderHero(next) {
        if (episode) { heroSlot.replaceChildren(heroBlock(episode)); return; }
        playNext.replaceChildren();
        if (next) {
          var label = (next.viewOffset ? 'Resume ' : 'Play ') + 'S' + next.parentIndex + ' E' + next.index;
          playNext.append(h('button.btn.btn-primary', { onclick: function () { playItem(next, next.viewOffset ? next.viewOffset / 1000 : 0); } }, icon('play'), label));
        }
        heroSlot.replaceChildren(heroBlock(sh, { actions: playNext }));
      }

      function pickSeason(s) {
        sel = s;
        Array.prototype.forEach.call(pills.children, function (p) { p.classList.toggle('on', p.dataset.key === s.key); });
        list.replaceChildren(h('div.skel', { style: { height: '140px' } }));
        api('/api/plex/item/' + s.key).then(function (season) {
          if (stale() || sel !== s) return;
          var eps = season.children || [];
          var next = eps.find(function (e) { return e.viewOffset; }) || eps.find(function (e) { return !e.viewCount; });
          renderHero(next || eps[0]);
          list.replaceChildren.apply(list, eps.map(episodeRow));
          if (!eps.length) list.replaceChildren(h('div.empty', 'No episodes.'));
        }).catch(fail);
      }

      seasons.forEach(function (s) {
        pills.appendChild(h('button.season-pill', { 'data-key': s.key, onclick: function () { pickSeason(s); } }, s.title));
      });
      renderHero(null);
      $('view').replaceChildren(heroSlot, h('div.page', { style: { paddingTop: '8px' } }, seasons.length > 1 ? pills : null, list));
      if (sel) pickSeason(sel);
    }).catch(fail);
  }

  function episodeRow(ep) {
    var progress = ep.viewOffset && ep.duration ? Math.min(100, 100 * ep.viewOffset / ep.duration) : 0;
    return h('button.ep', { onclick: function () { playItem(ep, ep.viewOffset ? ep.viewOffset / 1000 : 0); } },
      h('div.art', img(thumb(ep.thumb, 440, 248), ''), progress ? h('div.prog', h('i', { style: { width: progress + '%' } })) : null,
        h('div.hover', { html: ICON.play })),
      h('div', h('h3', h('span.n', ep.index + '.'), ep.title), ep.summary ? h('p', ep.summary) : null),
      h('div.dur', ep.viewCount && !progress ? h('span.watched', '✓ ') : null,
        progress ? fmtTime((ep.duration - ep.viewOffset) / 1000) + ' left' : ep.duration ? fmtDuration(ep.duration) : ''));
  }

  // ============================================================
  // Player
  // ============================================================
  // Pausing stops the stream and keeps the last frame on screen; resuming and
  // seeking start a new stream at that position (the pipeline is live-only).
  var P = {
    item: null, stream: null, canvas: null,
    offset: 0, firstFrameAt: 0, paused: false, ended: false,
    seekTarget: null, seekTimer: null, idleTimer: null, reportTimer: null,
    fps: 0, frames: 0, fpsAt: 0,
    level: '480', buffer: 0.25,
  };
  var player = $('player');

  // ============================================================
  // Adaptive quality
  // ============================================================
  // Each rung's worst-case stream rate: video maxrate + 128k audio + ~10% TS
  // overhead (see QUALITY in server.js). Auto picks the highest rung with
  // 50% headroom and stops at 720p, where JSMpeg's decode cost climbs.
  var LADDER = [{ q: '360', kbps: 1100 }, { q: '480', kbps: 1800 }, { q: '720', kbps: 3200 }];
  var ABR = { lastSwitch: 0, underrunAt: [], lastUnderruns: 0, backlogHits: 0, lateHits: 0, lastLate: 0, probing: false };

  function rung(q) { for (var i = 0; i < LADDER.length; i++) if (LADDER[i].q === q) return i; return 1; }

  // Download rate in kbit/s, timed from the response headers to the last
  // byte so connection setup doesn't count. Cached for 10 minutes.
  function measureBandwidth(kb) {
    var t1;
    return fetch('/api/speedtest?kb=' + (kb || 512) + '&_=' + Date.now(), { cache: 'no-store' }).then(function (r) {
      t1 = performance.now();
      return r.arrayBuffer();
    }).then(function (buf) {
      var kbps = Math.round(buf.byteLength * 8 / Math.max(1, performance.now() - t1));
      try { localStorage.setItem('canvasBandwidth', JSON.stringify({ kbps: kbps, at: Date.now() })); } catch (e) {}
      return kbps;
    });
  }
  function cachedBandwidth() {
    try {
      var b = JSON.parse(localStorage.getItem('canvasBandwidth') || 'null');
      if (b && Date.now() - b.at < 10 * 60 * 1000) return b.kbps;
    } catch (e) {}
    return 0;
  }
  function levelFor(kbps) {
    var pick = LADDER[0].q;
    LADDER.forEach(function (r) { if (kbps >= r.kbps * 1.5) pick = r.q; });
    return pick;
  }
  function initialLevel() {
    if (prefs.quality !== 'auto') return prefs.quality;
    var bw = cachedBandwidth();
    return bw ? levelFor(bw) : '480';
  }

  function switchLevel(q, why) {
    if (q === P.level) return;
    var up = rung(q) > rung(P.level);
    P.level = q;
    ABR.lastSwitch = performance.now();
    ABR.underrunAt = [];
    toast((up ? 'Quality up: ' : 'Quality down: ') + q + 'p' + (why ? ' (' + why + ')' : ''));
    startAt(position());
  }

  // Runs every 2 s while playing.
  function adapt() {
    if (!P.stream || P.paused || !P.firstFrameAt || P.seekTarget != null) return;
    var hl = P.stream.health();
    var now = performance.now();
    P.health = hl;

    if (hl.underruns > ABR.lastUnderruns) { ABR.underrunAt.push(now); ABR.lastUnderruns = hl.underruns; ABR.lastUnderrunAt = now; }
    // The next stream (after a seek, pause or switch) starts with this
    // stream's cushion, or half of it once things have been calm for a
    // minute, so a big cushion from one bad patch doesn't stick around.
    var calmFor = now - Math.max(ABR.lastUnderrunAt || 0, P.firstFrameAt);
    P.buffer = calmFor > 60000 ? Math.max(0.25, hl.buffer / 2) : hl.buffer;
    ABR.underrunAt = ABR.underrunAt.filter(function (t) { return now - t < 30000; });
    ABR.backlogHits = hl.backlogS > 2 ? ABR.backlogHits + 1 : 0;
    ABR.lateHits = hl.lateFrames - ABR.lastLate > 30 ? ABR.lateHits + 1 : 0;
    ABR.lastLate = hl.lateFrames;

    if (prefs.quality !== 'auto') return;
    var i = rung(P.level);
    if (i > 0) {
      if (ABR.underrunAt.length >= 2) return switchLevel(LADDER[i - 1].q, 'buffering');
      if (ABR.backlogHits >= 2) return switchLevel(LADDER[i - 1].q, 'slow connection');
      if (ABR.lateHits >= 2) return switchLevel(LADDER[i - 1].q, 'device too slow');
    }
    // Step up after a minute without trouble, if a quick test shows spare
    // bandwidth (measured while streaming, so it is what's left over).
    var calm = now - ABR.lastSwitch > 120000 && now - P.firstFrameAt > 60000 &&
      !ABR.underrunAt.length && hl.backlogS < 0.3 && !ABR.lateHits;
    if (i < LADDER.length - 1 && calm && !ABR.probing) {
      ABR.probing = true;
      measureBandwidth(512).then(function (spare) {
        ABR.probing = false;
        ABR.lastSwitch = performance.now(); // don't probe again for 2 minutes
        var extra = LADDER[i + 1].kbps - LADDER[i].kbps;
        if (P.stream && !P.paused && P.level === LADDER[i].q && spare >= extra * 1.5) switchLevel(LADDER[i + 1].q);
      }).catch(function () { ABR.probing = false; });
    }
  }
  setInterval(adapt, 2000);

  function durationS() { return P.item && P.item.duration ? P.item.duration / 1000 : 0; }
  function position() {
    if (P.seekTarget != null) return P.seekTarget;
    if (P.paused || !P.firstFrameAt) return P.offset;
    var d = durationS();
    var pos = P.offset + (performance.now() - P.firstFrameAt) / 1000;
    return d ? Math.min(pos, d) : pos;
  }

  function playItem(it, startSec) {
    P.item = it;
    P.ended = false;
    P.level = initialLevel();
    P.buffer = 0.25;
    ABR.lastSwitch = performance.now();
    ABR.underrunAt = [];
    ABR.lastUnderruns = 0;
    $('pTitle').textContent = it.type === 'episode' ? it.grandparentTitle : it.title;
    $('pSub').textContent = it.type === 'episode' ? epCode(it) + ' · ' + it.title : it.year || '';
    $('pDur').textContent = fmtTime(durationS());
    player.hidden = false;
    document.body.style.overflow = 'hidden';
    wake();
    startAt(startSec || 0);
    clearInterval(P.reportTimer);
    P.reportTimer = setInterval(function () { if (!P.paused) report('playing'); }, 10000);
  }

  function startAt(sec) {
    var d = durationS();
    if (d) sec = Math.max(0, Math.min(sec, d - 1));
    holdFrame();
    stopStream();
    P.offset = sec;
    P.firstFrameAt = 0;
    P.health = null;
    P.paused = false;
    P.seekTarget = null;
    P.frames = 0;
    P.fpsAt = performance.now();
    ABR.lastUnderruns = 0;
    ABR.lastLate = 0;
    ABR.backlogHits = ABR.lateHits = 0;
    setMsg('');
    $('pSpin').hidden = false;
    $('pBig').hidden = true;
    updatePlayBtn();

    // A fresh canvas per stream: JSMpeg tears down its WebGL context on
    // destroy. It stays hidden over the held frame until it has a picture.
    var canvas = h('canvas', { width: 854, height: 480, style: { visibility: 'hidden' } });
    $('screen').appendChild(canvas);
    P.canvas = canvas;

    P.stream = CanvasStream({
      canvas: canvas, audio: new Audio(), src: 'plex:' + P.item.key, mode: prefs.mode,
      quality: P.level, offset: sec, buffer: P.buffer,
      onStatus: function (t, isErr) { if (isErr) { setMsg(t, true); $('pSpin').hidden = true; } },
      onFrame: function () {
        if (!P.firstFrameAt) {
          P.firstFrameAt = performance.now();
          $('pSpin').hidden = true;
          // Swap in the new canvas only once it has a picture.
          canvas.style.visibility = '';
          Array.prototype.forEach.call($('screen').children, function (c) { if (c !== canvas) c.remove(); });
          report('playing');
        }
        P.frames++;
        var now = performance.now();
        if (now - P.fpsAt >= 1000) { P.fps = Math.round(P.frames * 1000 / (now - P.fpsAt)); P.frames = 0; P.fpsAt = now; }
      },
      onEnd: function (errored) {
        if (errored || P.paused) return;
        var d = durationS();
        if (d && position() > d - 10) {
          P.ended = true;
          P.paused = true;
          P.offset = d;
          $('pBig').hidden = false;
          updatePlayBtn();
          wake();
          report('stopped');
        } else {
          setMsg('The stream stopped unexpectedly.', true);
          $('pSpin').hidden = true;
        }
      },
    });
    applyVolume();
  }

  // Before a stream is torn down: copy its last picture into a plain 2D
  // canvas (JSMpeg's WebGL canvas goes blank on destroy) and drop every other
  // canvas, including ones from streams that never drew a frame.
  function holdFrame() {
    var screen = $('screen');
    var held = null;
    if (P.canvas && P.firstFrameAt && P.canvas.isConnected) {
      try {
        held = h('canvas.frame', { width: P.canvas.width, height: P.canvas.height });
        held.getContext('2d').drawImage(P.canvas, 0, 0);
      } catch (e) { held = null; }
    }
    if (!held) held = screen.querySelector('.frame');
    screen.replaceChildren.apply(screen, held ? [held] : []);
    P.canvas = null;
  }

  function stopStream() {
    if (P.stream) { P.stream.stop(); P.stream = null; }
  }

  function pause() {
    if (P.paused || !P.stream) return;
    var pos = position();
    holdFrame();
    stopStream();
    P.paused = true;
    P.offset = pos;
    $('pSpin').hidden = true;
    $('pBig').hidden = false;
    updatePlayBtn();
    wake();
    report('paused');
  }

  function togglePlay() {
    if (P.paused) { startAt(P.ended ? 0 : P.offset); P.ended = false; }
    else pause();
  }

  // Seeks are debounced so holding an arrow key or dragging restarts once.
  function seekTo(sec, immediate) {
    var d = durationS();
    P.seekTarget = Math.max(0, d ? Math.min(sec, d - 1) : sec);
    paintTime();
    clearTimeout(P.seekTimer);
    P.seekTimer = setTimeout(function () { var t = P.seekTarget; P.ended = false; startAt(t); }, immediate ? 0 : 450);
  }

  function closePlayer() {
    if (player.hidden) return;
    if (P.item && !P.ended) report('stopped', position());
    clearInterval(P.reportTimer);
    clearTimeout(P.seekTimer);
    stopStream();
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    $('screen').replaceChildren();
    player.hidden = true;
    document.body.style.overflow = '';
    P.item = null;
    route(true); // refresh progress bars and On Deck
  }

  function report(state, pos) {
    if (!P.item) return;
    api('/api/plex/timeline', {
      method: 'POST',
      body: { key: P.item.key, state: state, time: (pos != null ? pos : position()) * 1000, duration: P.item.duration },
    }).catch(function () {});
  }

  function setMsg(text, isErr) {
    var m = $('pMsg');
    m.hidden = !text;
    m.textContent = text || '';
    m.className = 'p-msg' + (isErr ? ' err' : '');
  }

  function updatePlayBtn() {
    var b = $('pPlay');
    b.innerHTML = P.paused ? ICON.play : ICON.pause;
    b.setAttribute('aria-label', P.paused ? 'Play' : 'Pause');
  }

  function applyVolume() {
    var v = prefs.muted ? 0 : prefs.volume;
    if (P.stream) P.stream.setVolume(v);
    $('pMute').innerHTML = prefs.muted || prefs.volume === 0 ? ICON.mute : ICON.vol;
    $('pVol').value = Math.round(prefs.volume * 100);
  }

  function paintTime() {
    var d = durationS(), pos = position();
    $('pCur').textContent = fmtTime(pos);
    var pct = d ? Math.min(100, 100 * pos / d) : 0;
    $('seekFill').style.width = pct + '%';
    $('seekKnob').style.left = pct + '%';
    $('pStats').textContent = P.firstFrameAt && !P.paused
      ? P.fps + ' fps · ' + P.level + 'p' + (prefs.quality === 'auto' ? ' auto' : '') + ' · ' + (P.health ? P.health.buffer : P.buffer).toFixed(2).replace(/0$/, '') + ' s buffer'
      : '';
  }
  setInterval(function () { if (!player.hidden && !drag) paintTime(); }, 250);

  // Auto-hide controls while playing.
  function wake() {
    player.classList.remove('idle');
    clearTimeout(P.idleTimer);
    P.idleTimer = setTimeout(function () {
      if (!P.paused && $('pMenu').hidden && !drag) player.classList.add('idle');
    }, 2800);
  }
  player.addEventListener('mousemove', wake);
  player.addEventListener('touchstart', wake, { passive: true });
  $('screen').addEventListener('click', function () { togglePlay(); });
  $('screen').addEventListener('dblclick', toggleFull);

  // Seek bar
  var drag = false;
  function seekFrac(e) {
    var r = $('seek').getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  }
  function moveTip(e) {
    var f = seekFrac(e);
    $('seekTip').style.left = (f * 100) + '%';
    $('seekTip').textContent = fmtTime(f * durationS());
    if (drag) {
      $('seekFill').style.width = (f * 100) + '%';
      $('seekKnob').style.left = (f * 100) + '%';
      $('pCur').textContent = fmtTime(f * durationS());
    }
  }
  $('seek').addEventListener('pointermove', moveTip);
  $('seek').addEventListener('pointerdown', function (e) {
    if (!durationS()) return;
    drag = true;
    this.classList.add('drag');
    this.setPointerCapture(e.pointerId);
    moveTip(e);
  });
  $('seek').addEventListener('pointerup', function (e) {
    if (!drag) return;
    drag = false;
    this.classList.remove('drag');
    seekTo(seekFrac(e) * durationS(), true);
  });

  // Buttons
  $('pPlay').onclick = togglePlay;
  $('pBig').onclick = togglePlay;
  $('pBack').onclick = function () { seekTo(position() - 10); };
  $('pFwd').onclick = function () { seekTo(position() + 30); };
  $('pClose').onclick = closePlayer;
  $('pMute').onclick = function () { prefs.muted = !prefs.muted; if (!prefs.muted && !prefs.volume) prefs.volume = .5; savePrefs(); applyVolume(); };
  $('pVol').oninput = function () { prefs.volume = this.value / 100; prefs.muted = false; savePrefs(); applyVolume(); };

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (player.requestFullscreen) player.requestFullscreen().catch(function () {});
    else if (player.webkitRequestFullscreen) player.webkitRequestFullscreen();
  }
  $('pFull').onclick = toggleFull;
  document.addEventListener('fullscreenchange', function () { $('pFull').innerHTML = document.fullscreenElement ? ICON.unfull : ICON.full; });
  $('pFull').innerHTML = ICON.full;

  // Settings menu
  $('pGear').onclick = function (e) {
    e.stopPropagation();
    var m = $('pMenu');
    if (!m.hidden) { m.hidden = true; return; }
    function opt(label, active, fn) {
      return h('button.menu-item', { onclick: function () { m.hidden = true; fn(); } }, label, active ? h('span', { html: ICON.check, style: { display: 'contents' } }) : null);
    }
    function restart() { if (!P.paused) startAt(position()); }
    fill(m,
      h('div.menu-label', 'Quality'),
      opt('Auto' + (prefs.quality === 'auto' ? ' (' + P.level + 'p)' : ''), prefs.quality === 'auto', function () { prefs.quality = 'auto'; savePrefs(); }),
      ['1080', '720', '480', '360'].map(function (q) {
        return opt(q + 'p', prefs.quality === q, function () { prefs.quality = q; P.level = q; savePrefs(); restart(); });
      }),
      h('div.menu-sep'),
      h('div.menu-label', 'Audio'),
      opt('In sync (WebAudio)', prefs.mode === 'muxed', function () { prefs.mode = 'muxed'; savePrefs(); restart(); }),
      opt('Legacy <audio> (≈5 s lag)', prefs.mode === 'split', function () { prefs.mode = 'split'; savePrefs(); restart(); }));
    m.hidden = false;
  };
  document.addEventListener('click', function (e) {
    if (!$('pMenu').hidden && !$('pMenu').contains(e.target)) $('pMenu').hidden = true;
  });

  // Keyboard
  document.addEventListener('keydown', function (e) {
    if (player.hidden) {
      if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
      return;
    }
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    var k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft' || k === 'j') { e.preventDefault(); seekTo(position() - 10); }
    else if (k === 'ArrowRight' || k === 'l') { e.preventDefault(); seekTo(position() + 30); }
    else if (k === 'ArrowUp') { e.preventDefault(); prefs.volume = Math.min(1, prefs.volume + .1); prefs.muted = false; savePrefs(); applyVolume(); }
    else if (k === 'ArrowDown') { e.preventDefault(); prefs.volume = Math.max(0, prefs.volume - .1); savePrefs(); applyVolume(); }
    else if (k === 'f') toggleFull();
    else if (k === 'm') $('pMute').click();
    else if (k === 'Escape' && !document.fullscreenElement) closePlayer();
    else return;
    wake();
  });

  window.addEventListener('pagehide', function () { if (P.item) report('stopped'); });

  boot();
})();
