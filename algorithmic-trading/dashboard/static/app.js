/* Rotation Ledger dashboard — reads /api/state, draws hairline SVG charts, triggers runs. */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmtPct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const fmtNum = (v, d = 2) => v == null || isNaN(v) ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtMoney = v => v == null ? '—' : '$' + fmtNum(v, 0);
  const sign = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let STATE = null, FILTER = 'all', QUERY = '';

  // ---------------------------------------------------------------- svg helpers
  const NS = 'http://www.w3.org/2000/svg';
  const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const scale = (d0, d1, r0, r1) => v => r0 + (v - d0) / ((d1 - d0) || 1) * (r1 - r0);
  const path = (xs, ys) => xs.map((x, i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + ys[i].toFixed(2)).join('');
  const niceTicks = (lo, hi, n = 4) => {
    const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= n) || mag * 10;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v); return out;
  };

  function lineChart(host, series, opts = {}) {
    host.innerHTML = '';
    const W = host.clientWidth || 600, H = host.clientHeight || 190;
    const m = { l: 44, r: 10, t: 10, b: 22 };
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    const n = series[0].values.length;
    const all = series.flatMap(s => s.values).filter(v => v != null && !isNaN(v));
    let lo = Math.min(...all), hi = Math.max(...all);
    if (opts.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
    const x = scale(0, n - 1, m.l, W - m.r), y = scale(lo, hi, H - m.b, m.t);
    // bands (regime)
    if (opts.bands) {
      let start = 0;
      for (let i = 1; i <= n; i++) {
        if (i === n || opts.bands[i] !== opts.bands[start]) {
          const r = el('rect', { x: x(start), y: m.t, width: x(i - 1) - x(start) + 1, height: H - m.b - m.t, class: 'band ' + (opts.bands[start] ? 'on' : 'off') });
          svg.appendChild(r); start = i;
        }
      }
    }
    niceTicks(lo, hi, 4).forEach(v => {
      svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'tick' }));
      const t = el('text', { x: m.l - 6, y: y(v) + 3, class: 'lbl', 'text-anchor': 'end' }); t.textContent = opts.fmt ? opts.fmt(v) : v; svg.appendChild(t);
    });
    svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }));
    if (opts.dates) {
      const k = Math.max(1, Math.floor(n / 6));
      for (let i = 0; i < n; i += k) { const t = el('text', { x: x(i), y: H - 6, class: 'lbl', 'text-anchor': i === 0 ? 'start' : 'middle' }); t.textContent = opts.dates[i].slice(0, 7); svg.appendChild(t); }
    }
    if (opts.area) {
      const s = series[opts.area], xs = [], ys = [];
      s.values.forEach((v, i) => { if (v != null) { xs.push(x(i)); ys.push(y(v)); } });
      svg.appendChild(el('path', { d: path(xs, ys) + `L${xs[xs.length - 1]} ${y(0)}L${xs[0]} ${y(0)}Z`, class: 'fillarea' }));
    }
    series.forEach(s => {
      const xs = [], ys = [];
      s.values.forEach((v, i) => { if (v != null && !isNaN(v)) { xs.push(x(i)); ys.push(y(v)); } });
      svg.appendChild(el('path', { d: path(xs, ys), class: 'ln ' + s.cls }));
      if (s.dot) svg.appendChild(el('circle', { cx: xs[xs.length - 1], cy: ys[ys.length - 1], r: 2.5, class: 'dot' }));
    });
    host.appendChild(svg);
  }

  function spark(values) {
    if (!values || values.length < 2) return '';
    const W = 72, H = 18, lo = Math.min(...values), hi = Math.max(...values);
    const x = scale(0, values.length - 1, 0.5, W - 0.5), y = scale(lo, hi, H - 1, 1);
    const d = path(values.map((_, i) => x(i)), values.map(y));
    const down = values[values.length - 1] < 1 ? ' down' : '';
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="sp${down}" d="${d}"/></svg>`;
  }

  // ---------------------------------------------------------------- render
  function render(s) {
    STATE = s;
    const empty = !s || s.empty;
    $('#empty').hidden = !empty;
    $$('main > section').forEach(e => e.hidden = empty);
    if (empty) return;

    const synthetic = /synthetic/.test(s.data_source);
    $('#chip-mode').textContent = s.mode;
    const src = $('#chip-source'); src.textContent = s.data_source; src.classList.toggle('warn', synthetic || /cache/.test(s.data_source));
    $('#chip-asof').textContent = 'as of ' + s.as_of;
    const rg = $('#chip-regime'); rg.textContent = s.regime.risk_on ? 'risk on' : 'risk off · cash'; rg.className = 'chip regime ' + (s.regime.risk_on ? 'on' : 'off');
    $('#generated').textContent = 'generated ' + s.generated_at.replace('T', ' ');

    // hero figure
    const bt = s.backtest, acct = s.account;
    let label, value, unit = '', cls = '', stats = [];
    if (acct) {
      label = 'Paper equity'; value = fmtMoney(acct.equity);
      stats = [[fmtMoney(acct.cash), 'cash'], [s.selected.length, 'positions'], [fmtPct(1 - s.cash_weight, 0), 'invested']];
    } else if (bt) {
      const st = bt.stats; label = 'Strategy return · ' + st.start.slice(0, 4) + '–' + st.end.slice(0, 4);
      value = (st.strategy_total_return >= 0 ? '+' : '') + fmtPct(st.strategy_total_return); cls = sign(st.strategy_total_return);
      stats = [[fmtPct(st.benchmark_total_return), 'benchmark'], [st.strategy_sharpe.toFixed(2), 'sharpe'], [fmtPct(st.strategy_max_drawdown), 'max dd']];
    } else {
      label = 'Universe screened'; value = s.universe_size; unit = 'names';
      stats = [[s.passing, 'pass gates'], [s.selected.length, 'selected'], [fmtPct(s.cash_weight, 0), 'cash']];
    }
    $('#hero-label').textContent = label; $('#hero-value').textContent = value; $('#hero-unit').textContent = unit;
    $('.figure .big').className = 'big ' + cls;
    $('#hero-stats').innerHTML = stats.map(([v, k]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');

    // regime chart
    const b = s.benchmark_series, bands = b.close.map((c, i) => b.sma[i] == null ? null : c > b.sma[i]);
    $('#regime-desc').textContent = `${s.regime.benchmark} ${fmtNum(s.regime.close)} · ${s.config.regime_sma}d ${fmtNum(s.regime.sma)} · ${(s.regime.distance >= 0 ? '+' : '') + fmtPct(s.regime.distance)}`;
    lineChart($('#regime-svg'), [{ values: b.sma, cls: 'sma' }, { values: b.close, cls: 'bench', dot: true }], { dates: b.dates, bands, fmt: v => Math.round(v) });

    // targets
    const tg = Object.entries(s.targets).sort((a, c) => c[1] - a[1]);
    const maxW = Math.max(...tg.map(t => t[1]), s.cash_weight, 0.01);
    $('#targets-note').textContent = s.config.weighting.replace('_', ' ') + ' · cap ' + fmtPct(s.config.max_weight, 0) + ' · ≤' + s.config.max_per_sector + '/sector';
    $('#targets-list').innerHTML = tg.map(([k, w]) => `<div class="tg"><span class="sym">${k}</span><span class="bar"><i style="width:${w / maxW * 100}%"></i></span><span class="w">${fmtPct(w)}</span></div>`).join('')
      + `<div class="tg cash"><span class="sym">CASH</span><span class="bar"><i style="width:${s.cash_weight / maxW * 100}%"></i></span><span class="w">${fmtPct(s.cash_weight)}</span></div>`;
    $('#sector-row').innerHTML = Object.entries(s.sector_counts || {}).sort((a, c) => c[1] - a[1]).map(([k, v]) => `<span>${esc(k)}<b>${v}</b></span>`).join('');

    renderTable();

    // method
    const c = s.config, w = c.weights;
    $('#method-list').innerHTML = [
      `Universe of <b>${s.universe_size}</b> liquid names across ${Object.keys(s.sector_counts || {}).length || 'all'} sectors, re-ranked every run.`,
      `Gates: price ≥ <b>$${c.min_price}</b>, 20d dollar volume ≥ <b>$${(c.min_dollar_volume / 1e6).toFixed(0)}M</b>, ${c.require_trend ? 'close > 50d > 200d mean,' : ''} RSI ≤ <b>${c.max_rsi}</b>.`,
      `Score = ${Object.entries(w).map(([k, v]) => `<b>${v > 0 ? '+' : ''}${v}</b>·${k.replace(/_/g, ' ')}`).join(' ')} (cross-sectional z-scores).`,
      `Own the top <b>${c.top_n}</b>, ${c.weighting.replace('_', ' ')}-weighted, max <b>${fmtPct(c.max_weight, 0)}</b> each and <b>${c.max_per_sector}</b> per sector.`,
      `Regime: all cash when <b>${c.benchmark}</b> closes below its <b>${c.regime_sma}</b>-day mean.${bt ? ` Rebalance every <b>${bt.config.rebalance_every}</b> days; <b>${fmtPct(bt.config.trailing_stop, 0)}</b> trailing stop.` : ''}`,
    ].map(t => `<li>${t}</li>`).join('');

    // account
    $('#account-panel').hidden = !acct;
    if (acct) {
      $('#acct-id').textContent = (acct.paper ? 'paper · ' : 'LIVE · ') + (acct.account_number || '');
      $('#acct-grid').innerHTML = [[fmtMoney(acct.equity), 'equity'], [fmtMoney(acct.cash), 'cash'], [fmtMoney(acct.buying_power), 'buying power'], [acct.status, 'status']].map(([v, k]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
      $('#positions tbody').innerHTML = (acct.positions || []).map(p => `<tr><td class="sym">${p.symbol}</td><td class="num">${fmtNum(p.qty, 2)}</td><td class="num">${fmtMoney(p.market_value)}</td><td class="num ${sign(p.unrealized_pl)}">${fmtPct(p.unrealized_plpc)}</td></tr>`).join('') || '<tr><td colspan="4" class="sec">no positions</td></tr>';
      $('#orders tbody').innerHTML = (s.orders || []).map(o => `<tr><td class="sym">${o.symbol}</td><td class="${o.side === 'buy' ? 'pos' : 'neg'}">${o.side}</td><td class="num">${fmtMoney(o.notional)}</td><td class="sec">${esc(o.status || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="sec">nothing to do</td></tr>';
    }

    // backtest
    $('#backtest-panel').hidden = !bt;
    if (bt) {
      const e = bt.equity, st = bt.stats;
      $('#bt-range').textContent = `${st.start} → ${st.end} · ${fmtMoney(bt.config.initial_cash)} start · ${bt.config.slippage_bps}bps slippage`;
      lineChart($('#equity-svg'), [{ values: e.benchmark, cls: 'bench' }, { values: e.strategy, cls: 'strat', dot: true }], { dates: e.dates, fmt: v => '$' + Math.round(v / 1000) + 'k' });
      lineChart($('#dd-svg'), [{ values: e.drawdown, cls: 'dd' }], { zero: true, area: 0, fmt: v => Math.round(v * 100) + '%' });
      const rows = [['total return', 'total_return', 1], ['cagr', 'cagr', 1], ['volatility', 'vol', 0], ['sharpe', 'sharpe', 0], ['max drawdown', 'max_drawdown', 1]];
      $('#bt-stats').innerHTML = `<div class="h"></div><div class="h n">strategy</div><div class="h n">bench</div>` + rows.map(([m, k, colour]) => {
        const a = st['strategy_' + k], c = st['benchmark_' + k], f = k === 'sharpe' ? v => v.toFixed(2) : fmtPct;
        return `<div class="m">${m}</div><div class="n ${colour ? sign(a) : ''}">${f(a)}</div><div class="n">${f(c)}</div>`;
      }).join('') + `<div class="m">trades</div><div class="n">${st.trades}</div><div class="n"></div><div class="m">win rate</div><div class="n">${fmtPct(st.win_rate, 0)}</div><div class="n"></div><div class="m">avg trade</div><div class="n ${sign(st.avg_trade_return)}">${fmtPct(st.avg_trade_return)}</div><div class="n"></div>`;
      $('#trades tbody').innerHTML = bt.trades.map(t => `<tr><td>${t.date}</td><td class="sym">${t.symbol}</td><td class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side}</td><td class="num">${fmtNum(t.qty, 1)}</td><td class="num">${fmtNum(t.price)}</td><td class="sec">${t.reason.replace(/_/g, ' ')}</td><td class="num ${sign(t.return)}">${t.return == null ? '' : fmtPct(t.return)}</td></tr>`).join('');
      $('#rebalances tbody').innerHTML = bt.rebalances.map(r => `<tr><td>${r.date}</td><td class="${r.risk_on ? 'pos' : 'neg'}">${r.risk_on ? 'on' : 'off'}</td><td class="sec">${r.selected.join(' ') || 'cash'}</td></tr>`).join('');
    }
  }

  function renderTable() {
    const s = STATE; if (!s) return;
    const q = QUERY.trim().toUpperCase();
    const rows = s.rankings.filter(r => FILTER === 'all' || (FILTER === 'passes' ? r.passes : r.selected))
      .filter(r => !q || r.symbol.includes(q) || (r.sector || '').toUpperCase().includes(q));
    const maxAbs = Math.max(...s.rankings.map(r => Math.abs(r.score || 0)), 0.01);
    $('#rank-count').textContent = `${rows.length} of ${s.rankings.length} · ${s.passing} pass gates`;
    $('#rank-table tbody').innerHTML = rows.map(r => {
      const sc = r.score || 0, half = 30, w = Math.abs(sc) / maxAbs * half;
      const bar = sc >= 0 ? `<b style="left:${half}px;width:${w}px"></b>` : `<b class="neg" style="left:${half - w}px;width:${w}px"></b>`;
      const gates = ['f_price', 'f_liquid', 'f_trend', 'f_rsi', 'f_data'].map(k => `<i class="${r[k] ? 'ok' : 'no'}" title="${k.slice(2)}"></i>`).join('');
      return `<tr class="${r.selected ? 'sel' : r.passes ? '' : 'fail'}">
        <td class="num">${r.rank}</td><td class="sym">${r.symbol}</td><td class="sec">${esc(r.sector)}</td>
        <td><span class="score"><span>${sc.toFixed(2)}</span><i>${bar}</i></span></td>
        <td class="num ${sign(r.mom_12_1)}">${fmtPct(r.mom_12_1, 0)}</td><td class="num ${sign(r.mom_6m)}">${fmtPct(r.mom_6m, 0)}</td><td class="num ${sign(r.mom_3m)}">${fmtPct(r.mom_3m, 0)}</td>
        <td class="num">${fmtPct(r.vol_20, 0)}</td><td class="num">${r.rsi_14 == null ? '—' : r.rsi_14.toFixed(0)}</td><td class="num">${fmtPct(r.from_high, 0)}</td>
        <td>${spark(r.spark)}</td><td class="num">${r.weight ? fmtPct(r.weight) : ''}</td><td><span class="gates">${gates}</span></td></tr>`;
    }).join('');
  }

  // ---------------------------------------------------------------- controls
  $$('.filters button').forEach(b => b.onclick = () => { $$('.filters button').forEach(x => x.classList.remove('on')); b.classList.add('on'); FILTER = b.dataset.filter; renderTable(); });
  $('#search').oninput = e => { QUERY = e.target.value; renderTable(); };

  async function load() {
    const r = await fetch('/api/state', { cache: 'no-store' });
    render(await r.json());
  }

  let poll = null;
  async function run(cmd) {
    const live = cmd === 'paper-live';
    if (live && !confirm('Submit real orders to the Alpaca PAPER account?')) return;
    const body = {
      cmd: live ? 'paper' : cmd, live_orders: live, source: $('#ctl-source').value, top: +$('#ctl-top').value,
      weighting: $('#ctl-weighting').value, years: +$('#ctl-years').value, rebalance: +$('#ctl-rebalance').value, stop: +$('#ctl-stop').value,
    };
    const log = $('#job-log'); log.hidden = false; log.className = 'log running'; log.textContent = `running ${body.cmd} (${body.source})…`;
    $$('.btn').forEach(b => b.disabled = true);
    const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) { log.className = 'log err'; log.textContent = j.error || 'failed'; $$('.btn').forEach(b => b.disabled = false); return; }
    clearInterval(poll);
    poll = setInterval(async () => {
      const job = await (await fetch('/api/job')).json();
      if (job.running) return;
      clearInterval(poll); $$('.btn').forEach(b => b.disabled = false);
      log.className = 'log ' + (job.returncode ? 'err' : ''); log.textContent = job.log.trim() || '(no output)';
      if (!job.returncode) load();
    }, 1000);
  }
  $$('.btn').forEach(b => b.onclick = () => run(b.dataset.cmd));
  window.addEventListener('resize', () => { if (STATE && !STATE.empty) render(STATE); });

  load().catch(e => { $('#empty').hidden = false; $('#empty p').textContent = 'Could not load /api/state: ' + e; });
})();
