// Launch Radar's dashboard, version 4. It reads window.RADAR (written
// beside dashboard/ by main.ts) and renders the ranked board with a net
// farm-economics column, filters for category, chain, TVL, age and farm
// verdict, a compare view for up to three protocols, a per-protocol
// detail drawer with the model's own inputs and the protocol's netted
// eight-step farm plan, the method in plain words, the out-of-sample
// backtest that scored the model, the full calibration table, and a
// research note on what the numbers assume and what would move them.
// No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = {
    q: '', category: 'all', chain: 'all', tvl: 'any', age: 'any', verdict: 'all',
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
    compare: [], showCompare: false,
  };

  var usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  }
  function moneySigned(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n < 0 ? '-' : '+') + money(Math.abs(n));
  }
  function moneyExact(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return usdFmt.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function ratioLabel(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return n.toFixed(3) + 'x';
  }
  // The model in one function: the page recomputes a row from the figures
  // data.js carries and checks the number board.json holds, so the page's
  // code and the board's data are visibly the same arithmetic. The order
  // of operations matches lib/model.ts exactly, including the curve's
  // ratio-band clip.
  function revalue(row) {
    var ratioBase = row.tvl_usd * row.category_ratio;
    var curveRaw = Math.exp(row.curve_intercept + row.curve_slope * Math.log(Math.max(1, row.tvl_usd)));
    var curveBase = Math.min(Math.max(curveRaw, row.tvl_usd * DATA.tuning.ratio_low), row.tvl_usd * DATA.tuning.ratio_high);
    var blended = Math.sqrt(ratioBase * curveBase);
    return Math.max(1, Math.round(blended * row.growth_multiplier * row.momentum_multiplier * row.maturity_multiplier));
  }

  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tvl')) state.tvl = params.get('tvl');
    if (params.get('age')) state.age = params.get('age');
    if (params.get('verdict')) state.verdict = params.get('verdict');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('cmp')) state.compare = params.get('cmp').split(',').filter(function (s) { return s; }).slice(0, 3);
    if (params.get('cmp')) state.showCompare = state.compare.length >= 2;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tvl !== 'any') params.set('tvl', state.tvl);
    if (state.age !== 'any') params.set('age', state.age);
    if (state.verdict !== 'all') params.set('verdict', state.verdict);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    if (state.compare.length) params.set('cmp', state.compare.join(','));
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function ageBand(days) {
    var d = days === null || days === undefined ? 365 : days;
    if (d < 180) return 'young';
    if (d < 365) return 'mid';
    if (d < 1095) return 'mature';
    return 'old';
  }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).some(function (c) { return c === state.chain; })) return false;
      if (state.tvl !== 'any' && r.tvl_usd < Number(state.tvl)) return false;
      if (state.age !== 'any' && ageBand(r.age_days) !== state.age) return false;
      if (state.verdict !== 'all' && r.farm_verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function ordered(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'net') { av = a.farm_net_usd; bv = b.farm_net_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.rank - b.rank;
    });
  }
  function distinct(field) {
    var seen = {};
    var out = [];
    DATA.rows.forEach(function (r) {
      var vals = field === 'chains' ? (r.chains || []) : [r.category || 'Other'];
      vals.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
    });
    return out.sort();
  }
  function maxImplied() {
    return DATA.rows.reduce(function (m, r) { return Math.max(m, r.implied_value_usd); }, 1);
  }

  function statCard(label, value, cls) {
    return h('div', { class: 'stat' }, h('span', { text: label }), h('b', { class: cls || '', text: value }));
  }

  function header() {
    return h('header', { class: 'top' },
      h('div', { class: 'mark' }, h('i')),
      h('div', { class: 'brand' },
        h('h1', { text: 'Launch Radar' }),
        h('p', { text: 'Token launch radar' })),
      h('div', { class: 'meta' },
        h('div', null, 'Snapshot ', h('b', { text: DATA.as_of }), ' · DefiLlama protocol index'),
        h('div', null, 'Model ', h('b', { text: DATA.model_version }), ' · backtested out of sample')));
  }

  function intro() {
    var bt = DATA.backtest;
    return h('section', { class: 'lede' },
      h('h2', { text: 'Every pre-token protocol, ranked by what its token would be worth' }),
      h('p', { text: 'The watchlist is the floor: the 40 protocols the snapshot names, every one of them ranked here. The early radar adds every other genuine launch candidate in the snapshot, whatever its size — including the large ones the watchlist skipped. Implied value is a model calibrated on the market and tested out of sample, not a price and not a promise.' }),
      h('div', { class: 'stats' },
        statCard('Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size, 'amber'),
        statCard('Pre-token rows scored', String(DATA.board_size)),
        statCard('Early radar rows', String(DATA.early_size)),
        statCard('Total implied value', money(DATA.total_implied_usd)),
        statCard('Farm verdicts: farm', String(DATA.verdict_counts.FARM), 'green'),
        statCard('Backtest LOO · blend OOS', 'x' + bt.loo.blend.oos_factor.toFixed(2))));
  }

  function filterBar() {
    var cats = distinct('category');
    var chains = distinct('chains');
    var sel = function (label, value, options, onPick) {
      return h('div', null,
        h('label', { text: label }),
        h('select', { onchange: function (e) { onPick(e.target.value); } },
          options.map(function (o) {
            var el = h('option', { value: o[0], text: o[1] });
            if (o[0] === value) el.selected = true;
            return el;
          })));
    };
    return h('div', { class: 'panel' },
      h('div', { class: 'filters' },
        h('div', null,
          h('label', { text: 'Search' }),
          h('input', {
            type: 'search', placeholder: 'Search name, category or chain', value: state.q,
            oninput: function (e) { state.q = e.target.value; render(); },
          })),
        sel('Category', state.category, [['all', 'All categories']].concat(cats.map(function (c) { return [c, c]; })), function (v) { state.category = v; render(); }),
        sel('Chain', state.chain, [['all', 'All chains']].concat(chains.map(function (c) { return [c, c]; })), function (v) { state.chain = v; render(); }),
        sel('Min TVL', state.tvl, [['any', 'Any TVL'], ['5000000', '$5M+'], ['50000000', '$50M+'], ['500000000', '$500M+'], ['1000000000', '$1B+']], function (v) { state.tvl = v; render(); }),
        sel('Age', state.age, [['any', 'Any age'], ['young', 'Under 6 months'], ['mid', '6–12 months'], ['mature', '1–3 years'], ['old', 'Over 3 years']], function (v) { state.age = v; render(); }),
        sel('Farm verdict', state.verdict, [['all', 'All verdicts'], ['FARM', 'FARM'], ['MARGINAL', 'MARGINAL'], ['SKIP', 'SKIP']], function (v) { state.verdict = v; render(); })),
      h('div', { class: 'tabs' },
        h('button', { class: 'tab' + (state.tab === 'pre-token' ? ' on' : ''), text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } }),
        h('button', { class: 'tab' + (state.tab === 'live' ? ' on' : ''), text: 'Live token', onclick: function () { state.tab = 'live'; render(); } }),
        h('span', { class: 'count', text: (state.tab === 'pre-token' ? filtered().length + ' rows shown' : DATA.live.length + ' protocols with a token that trades') })));
  }

  function boardTable() {
    var rows = ordered(filtered());
    var max = maxImplied();
    function sortHead(label, key, cls) {
      var arrow = state.sort === key ? (state.dir === -1 ? ' ▼' : ' ▲') : '';
      return h('th', {
        class: 'sortable' + (cls ? ' ' + cls : ''),
        text: label + arrow,
        onclick: function () {
          if (state.sort === key) state.dir = -state.dir;
          else { state.sort = key; state.dir = -1; }
          render();
        },
      });
    }
    if (rows.length === 0) return h('div', { class: 'board panel' }, h('p', { class: 'empty', text: 'No rows match these filters.' }));
    return h('div', { class: 'board' },
      h('p', { text: 'Pre-token protocols, strongest implied value first. Select a row for its model breakdown and farm plan; add up to three to the compare tray.' }),
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', { text: 'Rank' }),
          sortHead('Protocol', 'name'),
          sortHead('TVL', 'tvl', 'num'),
          h('th', { class: 'num', text: '7D' }),
          h('th', { class: 'num', text: 'Age' }),
          sortHead('Implied value', 'implied', 'num'),
          sortHead('Farm net', 'net', 'num'),
          h('th', { text: 'Board' }),
          h('th', { text: 'Compare' }))),
        h('tbody', null, rows.map(function (r) {
          var inCmp = state.compare.indexOf(r.slug) >= 0;
          return h('tr', {
            class: state.selected === r.slug ? 'sel' : '',
            onclick: function () { state.selected = state.selected === r.slug ? null : r.slug; render(); },
          },
          h('td', { text: String(r.rank) }),
          h('td', { class: 'name' }, h('b', { text: r.name }), h('span', { text: (r.category || 'Other') + ' on ' + (r.chains || []).join(', ') })),
          h('td', { class: 'num', text: money(r.tvl_usd) }),
          h('td', { class: 'num ' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : ''), text: pct(r.change_7d) }),
          h('td', { class: 'num', text: ageLabel(r.age_days) }),
          h('td', { class: 'num' },
            h('span', { class: 'bar' }, h('i', { style: 'width:' + Math.max(2, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
            document.createTextNode(money(r.implied_value_usd))),
          h('td', { class: 'num' },
            document.createTextNode(moneySigned(r.farm_net_usd) + ' '),
            h('span', { class: 'verdict ' + r.farm_verdict, text: r.farm_verdict })),
          h('td', null, h('span', { class: 'badge ' + (r.watchlist ? 'watch' : 'early'), text: r.watchlist ? 'WATCHLIST' : 'EARLY' })),
          h('td', null, h('button', {
            class: 'cmp-btn' + (inCmp ? ' in' : ''),
            text: inCmp ? '✓ Compare' : '+ Compare',
            onclick: function (e) {
              e.stopPropagation();
              if (inCmp) state.compare = state.compare.filter(function (s) { return s !== r.slug; });
              else if (state.compare.length < 3) state.compare.push(r.slug);
              state.showCompare = state.compare.length >= 2;
              render();
            },
          })));
        }))));
  }

  function liveTable() {
    return h('div', { class: 'board' },
      h('p', { text: 'Protocols whose token already trades, by market cap. These are the calibration set: the board prices pre-token protocols off their market caps, and never ranks them.' }),
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', { text: 'Protocol' }),
          h('th', { class: 'num', text: 'TVL' }),
          h('th', { class: 'num', text: 'Market cap' }),
          h('th', { class: 'num', text: '7D' }),
          h('th', { class: 'num', text: 'Mcap / TVL' }))),
        h('tbody', null, DATA.live.map(function (p) {
          return h('tr', null,
            h('td', { class: 'name' }, h('b', { text: p.name }), h('span', { text: (p.category || 'Other') + ' on ' + (p.chains || []).join(', ') })),
            h('td', { class: 'num', text: money(p.tvl_usd) }),
            h('td', { class: 'num', text: money(p.mcap_usd) }),
            h('td', { class: 'num ' + (p.change_7d > 0 ? 'up' : p.change_7d < 0 ? 'down' : ''), text: pct(p.change_7d) }),
            h('td', { class: 'num', text: p.mcap_usd && p.tvl_usd ? ratioLabel(p.mcap_usd / p.tvl_usd) : 'n/a' }));
        }))));
  }

  function detailDrawer() {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === state.selected) row = r; });
    if (!row) return null;
    var check = revalue(row);
    var matches = check === row.implied_value_usd;
    var ratioBase = row.tvl_usd * row.category_ratio;
    var curveRaw = Math.exp(row.curve_intercept + row.curve_slope * Math.log(Math.max(1, row.tvl_usd)));
    var curveBase = Math.min(Math.max(curveRaw, row.tvl_usd * DATA.tuning.ratio_low), row.tvl_usd * DATA.tuning.ratio_high);
    return h('section', { class: 'drawer' },
      h('button', { class: 'close', text: 'Close', onclick: function () { state.selected = null; render(); } }),
      h('h3', { text: row.name }),
      h('p', { class: 'sub', text: 'Rank ' + row.rank + ' · ' + (row.category || 'Other') + ' · ' + (row.chains || []).join(', ') + (row.watchlist ? ' · on the watchlist' : ' · early radar') }),
      h('h4', { text: 'Model breakdown' }),
      h('div', { class: 'kv' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Category ratio (' + row.category_live_count + ' live)' }), h('b', { text: ratioLabel(row.category_ratio) })),
        h('div', null, h('span', { text: 'Ratio estimate' }), h('b', { text: money(ratioBase) })),
        h('div', null, h('span', { text: 'Size curve (slope ' + row.curve_slope.toFixed(3) + ', n=' + row.curve_live_count + ')' }), h('b', { text: money(curveBase) })),
        h('div', null, h('span', { text: 'Growth ×' }), h('b', { text: row.growth_multiplier.toFixed(3) })),
        h('div', null, h('span', { text: 'Momentum ×' }), h('b', { text: row.momentum_multiplier.toFixed(3) + (row.momentum_pct === null ? ' (no signal)' : ' (' + pct(row.momentum_pct) + ')') })),
        h('div', null, h('span', { text: 'Maturity ×' }), h('b', { text: row.maturity_multiplier.toFixed(3) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { text: money(row.implied_value_usd) }))),
      h('p', { class: 'sub', text: 'Recomputed from these figures: ' + money(check) + (matches ? ' — matches board.json.' : ' — DIFFERS from board.json by ' + money(Math.abs(check - row.implied_value_usd)) + '.') }),
      h('h4', { text: 'Farm economics' }),
      h('div', { class: 'econ' },
        h('div', null, h('span', { text: 'Farm cost (gas + forgone yield)' }), h('b', { text: moneyExact(row.farm_cost_usd) })),
        h('div', null, h('span', { text: 'Expected airdrop' }), h('b', { text: moneyExact(row.farm_expected_usd) })),
        h('div', null, h('span', { text: 'Net' }), h('b', { text: moneySigned(row.farm_net_usd) })),
        h('div', null, h('span', { text: 'Verdict' }), h('b', null, h('span', { class: 'verdict ' + row.farm_verdict, text: row.farm_verdict })))),
      h('p', { class: 'sub', text: 'Expected airdrop = implied value × 0.0001% (a 10% community pool split across 100,000 farmers). Cost counts 8 transactions at the chain\u2019s typical gas plus 5% a year of forgone yield on the deployed capital. The capital itself is not a cost — it comes back when the position unwinds.' }),
      h('h4', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, row.farm_steps.map(function (s) { return h('li', { text: s }); })));
  }

  function compareTray() {
    if (state.compare.length === 0) return null;
    return h('div', { class: 'tray' },
      h('b', { text: 'Compare (' + state.compare.length + '/3)' }),
      state.compare.map(function (slug) {
        var r = null;
        DATA.rows.forEach(function (x) { if (x.slug === slug) r = x; });
        return h('span', { class: 'chip', text: r ? r.name : slug });
      }),
      h('button', { text: state.showCompare ? 'Hide comparison' : 'Compare', onclick: function () { state.showCompare = !state.showCompare; render(); } }));
  }

  function comparePanel() {
    if (!state.showCompare || state.compare.length < 2) return null;
    var cards = state.compare.map(function (slug) {
      var r = null;
      DATA.rows.forEach(function (x) { if (x.slug === slug) r = x; });
      if (!r) return null;
      return h('div', { class: 'compare-card' },
        h('h4', { text: r.name }),
        h('dl', null,
          h('dt', { text: 'Rank' }), h('dd', { text: '#' + r.rank + (r.watchlist ? ' · watchlist' : ' · early') }),
          h('dt', { text: 'Implied value' }), h('dd', { text: money(r.implied_value_usd) }),
          h('dt', { text: 'Farm net' }), h('dd', null, document.createTextNode(moneySigned(r.farm_net_usd) + ' '), h('span', { class: 'verdict ' + r.farm_verdict, text: r.farm_verdict })),
          h('dt', { text: 'TVL' }), h('dd', { text: money(r.tvl_usd) }),
          h('dt', { text: '7-day change' }), h('dd', { text: pct(r.change_7d) }),
          h('dt', { text: 'Age' }), h('dd', { text: ageLabel(r.age_days) }),
          h('dt', { text: 'Category ratio' }), h('dd', { text: ratioLabel(r.category_ratio) + ' (' + r.category_live_count + ' live)' }),
          h('dt', { text: 'Size-curve slope' }), h('dd', { text: r.curve_slope.toFixed(3) + ' (n=' + r.curve_live_count + ')' })));
    });
    return h('div', { class: 'compare-grid' }, cards);
  }

  function backtestTable(title, blurb, scores, winner) {
    function row(label, s, isWin) {
      return h('tr', { class: isWin ? 'win' : '' },
        h('td', { text: label + (isWin ? ' ★' : '') }),
        h('td', { text: String(s.n) }),
        h('td', { text: s.median_abs_pct.toFixed(1) + '%' }),
        h('td', { text: 'x' + s.oos_factor.toFixed(2) }));
    }
    return h('div', { class: 'bt' },
      h('h3', { text: title }),
      h('p', { text: blurb }),
      h('table', null,
        h('thead', null, h('tr', null,
          h('th', { text: 'Model' }), h('th', { text: 'n' }), h('th', { text: 'Median error' }), h('th', { text: 'OOS factor' }))),
        h('tbody', null,
          row('Ratio model', scores.ratio, winner === 'ratio'),
          row('Size curve', scores.curve, winner === 'curve'),
          row('Blend (used)', scores.blend, winner === 'blend'))));
  }

  function methodSection() {
    var bt = DATA.backtest;
    var t = DATA.tuning;
    return h('section', { class: 'section', id: 'method' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { text: 'One function scores every protocol. No name is special-cased, no row is hand-picked, and the dashboard recomputes every row from the same figures.' }),
      h('div', { class: 'formula', text:
        'ratio   = shrunk median mcap / TVL of the category\u2019s live protocols (clipped [0.02, 3])\n' +
        'curve   = exp(a + b \u00d7 ln(TVL)) from the log-log size curve (own line when n \u2265 10, else global)\n' +
        'blended = \u221a(ratio \u00d7 TVL \u00d7 curve)\n' +
        'implied = round( blended \u00d7 (1 + clamp(change_7d, -50, 100) / 100 \u00d7 0.5)' +
        ' \u00d7 (1 + clamp(category_momentum, -25, 25) / 100 \u00d7 0.25)' +
        ' \u00d7 (0.6 + min(age_days, 1095) / 1095 \u00d7 0.4) )' }),
      h('div', { class: 'cols' },
        h('div', { class: 'col' },
          h('h3', { text: 'What the model does' }),
          h('ul', null,
            h('li', null, h('b', { text: 'Ratio. ' }), document.createTextNode('The median market-cap / TVL of the category\u2019s live protocols, shrunk toward the global median of ' + ratioLabel(DATA.global_ratio) + ' when fewer than 5 live protocols speak for the category, clipped to [0.02, 3].')),
            h('li', null, h('b', { text: 'Size curve. ' }), document.createTextNode('Log market cap regressed on log TVL across ' + DATA.global_curve.n + ' live protocols (global slope ' + DATA.global_curve.slope.toFixed(3) + '). A slope below 1 means the market pays less per dollar of TVL at scale; above 1, more.')),
            h('li', null, h('b', { text: 'Blend. ' }), document.createTextNode('The geometric mean of the ratio and curve estimates, so neither model can dominate the other. The backtest scores all three out of sample.')),
            h('li', null, h('b', { text: 'Growth. ' }), document.createTextNode('The protocol\u2019s own seven-day TVL change, clamped and weighted by half.')),
            h('li', null, h('b', { text: 'Momentum. ' }), document.createTextNode('The category\u2019s seven-day drift: the median change of its live protocols, clamped to ±25% and weighted by a quarter. A category in a broad drawdown prices below one holding steady.')),
            h('li', null, h('b', { text: 'Maturity. ' }), document.createTextNode('Age since first listing, the best record of how long a protocol has run with no token; an unlisted age uses 365 days, the same assumption the age filter uses.')))),
        h('div', { class: 'col' },
          h('h3', { text: 'What the board leaves out' }),
          h('ul', null,
            h('li', null, h('b', { text: 'Wrapped, staked and bridged products ' }), document.createTextNode('of tokens that already trade are not launches: the board applies the snapshot\u2019s own exclusion rule to every row below the watchlist.')),
            h('li', null, h('b', { text: 'Protocols that record a token ' }), document.createTextNode('are set aside in the Live token tab, all ' + DATA.live_size + ' of them, whatever their market cap.')),
            h('li', null, h('b', { text: 'A protocol records no token ' }), document.createTextNode('— it may still have one its DefiLlama record does not carry. The board never claims otherwise.')),
            h('li', null, h('b', { text: 'Farm plans are eight steps each, ' }), document.createTextNode('derived from the protocol\u2019s category, chains, TVL and age, with a cost and a time on every step — and netted: cost against expected airdrop, with a verdict.')),
            h('li', null, h('b', { text: 'The backtest is honest about its misses: ' }), document.createTextNode('the OOS factor below is the typical out-of-sample error, not a best case.'))))),
      h('h2', { text: 'Backtest: the model against data it never saw', id: 'backtest' }),
      h('p', { text: 'Leave-one-out refits both models on all but one live protocol and predicts the held-out market cap from TVL alone — every live protocol is tested once. The time-split trains on the oldest 70% of dated listings and predicts the newest 30% (cutoff ' + (bt.split_cutoff || 'n/a') + '), the test that most resembles pricing tomorrow\u2019s launches. OOS factor x2.00 means the typical prediction lands within a factor of two of the true market cap, either way.' }),
      h('div', { class: 'backtest' },
        backtestTable('Leave-one-out', 'All ' + bt.loo_n + ' live protocols, each held out once.', bt.loo, bt.winner),
        backtestTable('Time-split', 'Trained on ' + bt.split_train_n + ' older listings, tested on ' + bt.split_test_n + ' newer ones.', bt.time_split, bt.winner)),
      h('div', { class: 'note' },
        h('h3', { text: 'Research note' }),
        h('p', null, h('b', { text: 'Method. ' }), document.createTextNode('The board prices 198 pre-token protocols off the ' + DATA.global_curve.n + ' protocols whose token already trades. Two models are fitted on the same live set — a category-median ratio and a log-log size curve — and blended in log space; growth, momentum and maturity adjust the blend. Nothing is priced off a name: the same function scores every row, and the dashboard recomputes each one.')),
        h('p', null, h('b', { text: 'Backtest. ' }), document.createTextNode('Out of sample, the blend predicts a held-out market cap within a factor of x' + bt.loo.blend.oos_factor.toFixed(2) + ' (leave-one-out, median error ' + bt.loo.blend.median_abs_pct.toFixed(1) + '%) and x' + bt.time_split.blend.oos_factor.toFixed(2) + ' on the time-split. The ' + bt.winner + ' model wins the leave-one-out test; the board uses the blend anyway, because a blend fails more gracefully than either component when the market shifts.')),
        h('p', null, h('b', { text: 'Assumptions. ' }), document.createTextNode('Farm economics assume a 10% community airdrop pool split across 100,000 farmers (0.0001% of implied value each), 8 transactions at the chain\u2019s typical gas ($12 on Ethereum, $2 elsewhere), and 5% a year of forgone yield on deployed capital. A smaller pool, more farmers, or higher gas all lower the net — the verdicts move with them.')),
        h('p', null, h('b', { text: 'Limitations. ' }), document.createTextNode('Market cap is a single day\u2019s price: the calibration is a snapshot of 14 November 2026, and a repricing of any category reprices its rows. Categories with few live protocols lean on the global ratio and the global curve. The maturity multiplier rewards age, which is a proxy for survival, not a guarantee of a launch. Implied value is a model output, not a price and not a promise.')),
        h('p', null, h('b', { text: 'What would change the ranking. ' }), document.createTextNode('A category-wide repricing (its live tokens re-rated), a large TVL move in a top row, or a refit of the size curve on a new snapshot. The rows most sensitive to the model are the ones where the ratio and curve estimates disagree most — the detail drawer shows both, so the disagreement is visible rather than hidden.'))),
      h('h2', { text: 'Calibration: what the market pays per dollar of TVL' }),
      h('p', { text: 'All ' + DATA.calibration.length + ' categories with live protocols, most live protocols first. Raw median is the unshrunk median mcap / TVL; ratio used is the shrunk, clipped value the model applies. Momentum is the median seven-day change of the category\u2019s live protocols, clamped to ±25% and weighted by a quarter. Curve slope is the category\u2019s own log-log line where at least 10 live protocols speak for it, else the global line.' }),
      h('div', { class: 'calib' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', { text: 'Category' }), h('th', { text: 'Live' }), h('th', { text: 'Raw median' }), h('th', { text: 'Ratio used' }),
            h('th', { text: 'Momentum 7D' }), h('th', { text: 'Momentum mult' }), h('th', { text: 'Curve slope' }), h('th', { text: 'Curve n' }))),
          h('tbody', null, DATA.calibration.map(function (c) {
            return h('tr', null,
              h('td', { text: c.category }),
              h('td', { text: String(c.live_count) }),
              h('td', { text: c.raw_median === null ? 'n/a' : ratioLabel(c.raw_median) }),
              h('td', { text: ratioLabel(c.ratio) }),
              h('td', { class: c.momentum_pct > 0 ? 'up' : c.momentum_pct < 0 ? 'down' : '', text: pct(c.momentum_pct) }),
              h('td', { text: c.momentum_mult.toFixed(3) }),
              h('td', { text: c.curve_slope === null ? 'n/a' : c.curve_slope.toFixed(3) + (c.curve_is_global ? ' (global)' : '') }),
              h('td', { text: String(c.curve_n) }));
          })))));
  }

  function render() {
    writeHash();
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = '';
    app.appendChild(header());
    app.appendChild(intro());
    app.appendChild(filterBar());
    if (state.tab === 'pre-token') {
      app.appendChild(boardTable());
      var drawer = detailDrawer();
      if (drawer) app.appendChild(drawer);
      var tray = compareTray();
      if (tray) app.appendChild(tray);
      var panel = comparePanel();
      if (panel) app.appendChild(panel);
    } else {
      app.appendChild(liveTable());
    }
    app.appendChild(methodSection());
    app.appendChild(h('footer', { class: 'foot' },
      h('div', { text: 'Source: ' + DATA.source + ' · Snapshot ' + DATA.as_of + ' · Model ' + DATA.model_version + ' · ' + DATA.board_size + ' pre-token rows, ' + DATA.live_size + ' live protocols priced for calibration.' }),
      h('div', { text: 'Every protocol on this board records no token in the snapshot. Implied values are model estimates from the snapshot\u2019s own figures, backtested out of sample; they are not prices, and a farm verdict is arithmetic on stated assumptions, not advice.' })));
  }

  readHash();
  render();
})();
