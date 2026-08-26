/* X Signal Bot dashboard.
 *
 * Plain ES modules, no framework: the whole system is dependency-free, and the
 * dashboard is a read/act surface over the JSON API, not an application in its
 * own right.
 */

const $ = (sel) => document.querySelector(sel);
let state = null;
let health = null;
let selectedSignalId = null;

/* ------------------------------------------------------------- helpers */

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || body?.detail || `${res.status} ${res.statusText}`);
  return body;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  setTimeout(() => el.classList.add('hidden'), 6000);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function signClass(n) {
  if (n === null || n === undefined) return 'flat';
  return n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
}

function pct(n, digits = 2) {
  if (n === null || n === undefined) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function time(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function bandClass(band) {
  if (band === 'STRONG_BULLISH' || band === 'BULLISH') return 'chip-good';
  if (band === 'STRONG_BEARISH' || band === 'BEARISH') return 'chip-bad';
  return '';
}

/* --------------------------------------------------------------- load */

async function load() {
  try {
    [state, health] = await Promise.all([
      api('/api/dashboard'),
      api('/api/observability').catch(() => null),
    ]);
    render();
  } catch (e) {
    toast(`Failed to load dashboard: ${e.message}`, 'bad');
  }
}

function render() {
  renderHeader();
  renderOps();
  renderHealth();
  renderStats();
  renderChart();
  renderApprovals();
  renderSignals();
  renderProposals();
  renderPositions();
  renderTrades();
  renderPerformance();
  renderSources();
  renderRisk();
  renderApi();
  renderFunnel();
  renderXFeed();
  $('#generated-at').textContent = `Generated ${time(state.generatedAt)}`;
}

/* ---------------------------------------------------------------- ops */

/**
 * Above the fold.
 *
 * These are the fields an operator needs to answer "is it working and is it
 * safe?" without scrolling. Everything else on the page is detail behind one
 * of these cells.
 */
function renderOps() {
  const body = $('#ops-body');
  if (!health || !health.summary) {
    body.innerHTML = '<div class="empty">Observability endpoint unavailable.</div>';
    return;
  }

  const s = health.summary;
  const c = health.cadence;

  $('#ops-note').textContent =
    `X scan ${c.xScanSeconds}s · positions ${c.positionMonitorSeconds}s · reconcile ${c.reconciliationSeconds}s · ` +
    `~${c.estimatedDailyXRequests} X requests per trading day`;

  const pollTone = s.pollingState === 'API_PRESSURE' ? 'bad' : s.pollingState === 'EVENT_WATCH' ? 'warn' : 'ok';
  const budgetPct = s.xRequestBudget > 0 ? Math.round((s.xRequestsToday / s.xRequestBudget) * 100) : 0;

  const watching = (health.eventWatch || [])
    .map((w) => `${w.ticker} (${w.minutesLeft}m)`)
    .join(', ');

  body.innerHTML = `<div class="health-grid">
    ${cell('Connected', s.connected ? 'YES' : 'NO', s.connected ? 'ok' : 'warn', s.connectedDetail)}
    ${cell('Polling', s.pollingState, pollTone, s.pollingReason)}
    ${cell('Next X scan', `${s.nextScanSeconds}s`, '', watching ? `watching ${watching}` : 'baseline cadence')}
    ${cell('Last X scan', ago(s.minutesSinceLastScan), staleTone(s.minutesSinceLastScan, health.process.uptimeMinutes, 10, 30),
      s.lastScanAt ? time(s.lastScanAt) : 'no scan yet this process')}

    ${cell('Newest post seen', ago(s.minutesSinceLastPost), '',
      s.lastPostSeenAt ? time(s.lastPostSeenAt) : 'no posts stored')}
    ${cell('X requests today', `${s.xRequestsToday} / ${s.xRequestBudget}`,
      budgetPct >= 100 ? 'bad' : budgetPct >= 75 ? 'warn' : 'ok', `${budgetPct}% of the soft daily cap`)}
    ${cell('Trades today', String(s.tradesToday), '',
      s.tradesToday === 0 ? 'zero trades is a valid day' : 'entry orders submitted')}
    ${cell('Open positions', String(s.openPositions), '', `equity ${s.equity}`)}
    ${cell('US market', s.marketOpen ? 'OPEN' : 'CLOSED', s.marketOpen ? 'ok' : '', s.marketReason || '')}

    ${cell('Run state', s.runState, s.runState === 'RUNNING' ? 'ok' : s.runState === 'KILLED' ? 'bad' : 'warn',
      health.strategy.haltReason || 'no halt reason')}
    ${cell('Kill switch', s.killSwitch ? 'ENGAGED' : 'ARMED', s.killSwitch ? 'bad' : 'ok', s.killSwitch ? 'no new orders' : 'ready')}
    ${cell('Same-ticker cooldown', `${c.sameTickerCooldownMinutes}m`, '', 'minimum gap between entries in one name')}
    ${cell('Signal TTL', `${c.signalTtlMinutes}m`, '', 're-checked immediately before every order')}
  </div>`;
}

/* ---------------------------------------------------------------- api */

function renderApi() {
  const body = $('#api-body');
  if (!health || !health.api) {
    body.innerHTML = '<div class="empty">No API telemetry.</div>';
    return;
  }

  body.innerHTML = health.api.map((a) => {
    const tone = a.pressured ? 'bad' : a.errors > 0 ? 'warn' : 'ok';
    const headroom = a.rateLimitRemaining === null
      ? 'not advertised'
      : `${a.rateLimitRemaining}/${a.rateLimitLimit ?? '?'} left${a.rateLimitResetAt ? `, resets ${time(a.rateLimitResetAt)}` : ''}`;
    return `<div class="health-cell ${tone}" style="margin-bottom:8px">
      <div class="k">${esc(a.provider.toUpperCase())}</div>
      <div class="v">${a.requests} requests · ${a.successes} ok · ${a.rateLimited} rate-limited · ${a.errors} errors</div>
      <div class="s">last success ${ago(a.minutesSinceSuccess)} · headroom ${esc(headroom)}${
        a.softCapUsedPct === null ? '' : ` · ${a.softCapUsedPct}% of daily budget`}</div>
      ${a.lastErrorAt ? `<div class="s">last error ${esc(a.lastErrorKind || '')}: ${esc(a.lastErrorDetail || '')}</div>` : ''}
      ${a.pressured ? `<div class="s">UNDER PRESSURE — ${esc(a.pressureReason)}</div>` : ''}
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------- funnel */

function renderFunnel() {
  const body = $('#funnel-body');
  if (!health || !health.funnel) {
    body.innerHTML = '<div class="empty">No funnel data.</div>';
    return;
  }

  const stages = health.funnel.stages;
  const top = Math.max(1, ...stages.map((s) => s.count));

  body.innerHTML = `<div class="funnel">${stages.map((s) => {
    const pct = Math.round((s.count / top) * 100);
    const stalled = health.funnel.stalledAt === s.stage;
    return `<div class="funnel-row${stalled ? ' funnel-stalled' : ''}" title="${esc(s.meaning)}">
      <div class="funnel-label">${esc(s.stage)}</div>
      <div class="funnel-bar"><div class="funnel-fill" style="width:${pct}%"></div></div>
      <div class="funnel-count">${s.count}</div>
    </div>`;
  }).join('')}</div>
  <div class="s" style="margin-top:10px">${esc(health.funnel.narrative)}</div>`;
}

/* ------------------------------------------------------------ X feed */

function renderXFeed() {
  const tbody = $('#xfeed-table tbody');
  const feed = (health && health.feed) || [];

  $('#xfeed-note').textContent = feed.length === 0
    ? 'No posts ingested yet.'
    : `${feed.length} most recent posts, with the pipeline's decision on each.`;

  if (feed.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Nothing ingested yet.</td></tr>';
    return;
  }

  tbody.innerHTML = feed.map((f) => {
    const verdictClass = f.verdict === 'ACCEPT' ? 'chip-good'
      : f.verdict === 'DOWNWEIGHT' ? 'chip-warn'
      : f.verdict === 'REJECT' ? 'chip-bad' : '';
    const reasons = f.verdictReasons.length ? f.verdictReasons.join(', ') : '';
    return `<tr>
      <td class="mono">${esc(time(f.capturedAt))}</td>
      <td>@${esc(f.handle)} <span class="chip">${esc(f.tier)}</span></td>
      <td class="feed-text" title="${esc(f.text)}">${esc(f.text)}</td>
      <td><span class="chip ${verdictClass}">${esc(f.verdict || 'PENDING')}</span>${
        reasons ? `<div class="s">${esc(reasons)}</div>` : ''}</td>
      <td class="mono">${esc(f.resolvedTickers.join(', ') || '—')}</td>
      <td class="mono">${f.signalScore === null ? '—' : (f.signalScore > 0 ? `+${f.signalScore}` : f.signalScore)}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------- health */

function ago(minutes) {
  if (minutes === null || minutes === undefined) return 'never';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h ago`;
  return `${(minutes / 1440).toFixed(1)}d ago`;
}

function cell(label, value, tone, sub) {
  return `<div class="health-cell ${tone}">
    <div class="k">${esc(label)}</div>
    <div class="v">${esc(value)}</div>
    ${sub ? `<div class="s">${esc(sub)}</div>` : ''}
  </div>`;
}

/**
 * Staleness tone. A provider that has never succeeded IS a problem once the
 * process has been up long enough to have tried; before that it is just early.
 */
function staleTone(minutes, uptimeMinutes, warnAfter, badAfter) {
  if (minutes === null) return uptimeMinutes > warnAfter ? 'bad' : '';
  if (minutes >= badAfter) return 'bad';
  if (minutes >= warnAfter) return 'warn';
  return 'ok';
}

function renderHealth() {
  const body = $('#health-body');
  if (!health) {
    body.innerHTML = '<div class="empty">Observability endpoint unavailable.</div>';
    return;
  }

  const p = health.providers;
  const pr = health.process;
  const up = pr.uptimeMinutes;

  $('#health-note').textContent =
    `Process up ${ago(up)} · ${p.allReal ? 'all providers live' : 'fixtures in use'}` +
    (p.forcedFixtures ? ' (forced by NORTHSTAR_USE_FIXTURES)' : '');

  const killTone = health.killSwitch.engaged ? 'bad' : 'ok';
  const runTone = health.strategy.runState === 'RUNNING' ? 'ok'
    : health.strategy.runState === 'KILLED' ? 'bad' : 'warn';

  body.innerHTML = `<div class="health-grid">
    ${cell('X provider', p.x, p.x === 'LIVE' ? 'ok' : 'warn', p.ids.social)}
    ${cell('Market data', p.marketData, p.marketData === 'TIINGO' ? 'ok' : 'warn', p.ids.marketData)}
    ${cell('Broker', p.broker, p.broker.startsWith('ALPACA') ? 'ok' : 'warn', p.ids.broker)}
    ${cell('Mode', p.mode, p.mode === 'LIVE' ? 'warn' : 'ok', `strategy ${health.strategy.version}`)}

    ${cell('Last X ingest', ago(pr.staleness.social),
      staleTone(pr.staleness.social, up, 60, 180),
      pr.consecutiveFailures.social ? `${pr.consecutiveFailures.social} consecutive failures` : 'since process start')}
    ${cell('Last price refresh', ago(pr.staleness.marketData),
      staleTone(pr.staleness.marketData, up, 60, 180),
      pr.consecutiveFailures.marketData ? `${pr.consecutiveFailures.marketData} consecutive failures` : 'since process start')}
    ${cell('Last broker success', ago(pr.staleness.broker),
      staleTone(pr.staleness.broker, up, 120, 360),
      pr.consecutiveFailures.broker ? `${pr.consecutiveFailures.broker} consecutive failures` : 'since process start')}
    ${cell('Stored events (24h)', String(health.stored.storedEventsLast24h), '',
      health.stored.lastStoredEventAt ? `last ${time(health.stored.lastStoredEventAt)}` : 'none stored')}

    ${cell('Ledger equity', health.ledger.equity, health.ledger.integrityOk ? 'ok' : 'bad',
      health.ledger.integrityOk ? 'reconciles with entry log' : 'LEDGER MISMATCH')}
    ${cell('Reserved capital', health.ledger.reserved,
      health.ledger.reservedCents > health.ledger.equityCents ? 'bad' : '', 'committed to unfilled orders')}
    ${cell('Open orders', String(health.exposure.openOrders), '',
      health.exposure.pendingApprovals ? `${health.exposure.pendingApprovals} awaiting approval` : 'none pending approval')}
    ${cell('Open positions', `${health.exposure.openPositions} / ${health.exposure.maxPositions}`, '', 'concurrent limit')}

    ${cell('Risk state', health.risk.breached ? 'BREACHED' : 'WITHIN LIMITS',
      health.risk.breached ? 'bad' : 'ok',
      `daily ${health.risk.dailyLossPct.toFixed(2)}%/${health.risk.maxDailyLossPct}% · DD ${health.risk.drawdownPct.toFixed(2)}%/${health.risk.maxDrawdownPct}%`)}
    ${cell('Strategy state', health.strategy.runState, runTone, health.strategy.status)}
    ${cell('Kill switch', health.killSwitch.engaged ? 'ENGAGED' : 'ARMED', killTone,
      health.killSwitch.engaged
        ? (health.killSwitch.liquidateOnKill ? 'liquidation selected' : 'positions untouched')
        : 'ready')}
    ${cell('Open incidents', String(health.killSwitch.openIncidents.length),
      health.killSwitch.openIncidents.length ? 'bad' : 'ok',
      health.killSwitch.openIncidents[0]?.fault ?? 'none')}
  </div>
  ${health.risk.breached ? `<div class="banner" style="margin-top:12px">Risk breach: ${esc(health.risk.breachReasons.join('; '))}</div>` : ''}
  ${!health.ledger.integrityOk ? `<div class="banner" style="margin-top:12px">${esc(health.ledger.integrityDetail)}</div>` : ''}`;
}

/* ------------------------------------------------------------- header */

function renderHeader() {
  const h = state.header;
  $('#strategy-id').textContent = h.strategyId;
  $('#strategy-version').textContent = `v${h.version}`;

  const status = $('#status-chip');
  status.textContent = h.status;
  status.className = `chip ${h.status === 'THRIVING' ? 'chip-good' : h.status === 'PROBATION' ? 'chip-warn' : h.status === 'RETIRED' ? 'chip-bad' : 'chip-accent'}`;

  const run = $('#runstate-chip');
  run.textContent = h.runState;
  run.className = `chip ${h.runState === 'RUNNING' ? 'chip-good' : h.runState === 'KILLED' ? 'chip-bad' : 'chip-warn'}`;

  const mode = $('#mode-chip');
  mode.textContent = `${h.mode} MODE`;
  mode.className = `chip ${h.mode === 'LIVE' ? 'chip-bad' : 'chip-accent'}`;

  const banner = $('#halt-banner');
  if (h.haltReason) {
    banner.textContent = `${h.runState}: ${h.haltReason}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  $('#btn-resume').classList.toggle('hidden', h.runState === 'RUNNING');
  $('#btn-kill').disabled = h.runState === 'KILLED';
}

function renderStats() {
  const h = state.header;
  const stats = [
    { label: 'Allocated capital', value: h.allocatedCapital, sub: `${h.mode} · broker ${h.brokerMode}` },
    { label: 'Current equity', value: h.currentEquity, sub: `Return ${pct(h.totalReturnPct)}`, cls: signClass(h.totalReturnPct) },
    { label: 'Total return', value: pct(h.totalReturnPct), cls: signClass(h.totalReturnPct), sub: 'Since inception' },
    { label: `Benchmark (${h.benchmarkTicker})`, value: pct(h.benchmarkReturnPct), cls: signClass(h.benchmarkReturnPct), sub: 'Same window' },
    { label: 'Alpha', value: pct(h.alphaPct), cls: signClass(h.alphaPct), sub: 'Strategy − benchmark' },
    { label: 'Drawdown', value: pct(-Math.abs(h.drawdownPct)), cls: h.drawdownPct > 0 ? 'neg' : 'flat', sub: `Limit ${h.maxDrawdownPct}%` },
    { label: 'Open positions', value: `${h.openPositions} / ${h.maxPositions}`, sub: 'Concurrent limit' },
    { label: 'Signals today', value: String(h.signalsToday), sub: `${h.proposalsToday} proposals · ${h.tradesToday} closed` },
  ];

  $('#stats').innerHTML = stats.map((s) => `
    <div class="stat">
      <div class="stat-label">${esc(s.label)}</div>
      <div class="stat-value ${s.cls || ''}">${esc(s.value)}</div>
      <div class="stat-sub">${esc(s.sub || '')}</div>
    </div>`).join('');
}

/* -------------------------------------------------------------- chart */

function renderChart() {
  const data = state.equityCurve;
  const note = $('#chart-note');
  if (!data || data.length < 2) {
    $('#equity-chart').innerHTML = '<div class="empty">Not enough equity history yet — run a few cycles.</div>';
    note.textContent = '';
    return;
  }
  note.textContent = `Benchmark indexed to the strategy's starting capital · ${data.length} snapshots`;

  const W = 1000;
  const H = 280;
  const pad = { top: 16, right: 16, bottom: 26, left: 56 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const equities = data.map((d) => d.equity);
  const benches = data.map((d) => d.benchmarkIndexed).filter((v) => v !== null);
  const all = equities.concat(benches);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const lo = min - span * 0.08;
  const hi = max + span * 0.08;

  const x = (i) => pad.left + (i / (data.length - 1)) * innerW;
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo)) * innerH;

  const line = (values) => values
    .map((v, i) => (v === null ? null : `${i === 0 || values[i - 1] === null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean).join(' ');

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = lo + (hi - lo) * (1 - f);
    const yy = pad.top + innerH * f;
    return `<line x1="${pad.left}" y1="${yy}" x2="${W - pad.right}" y2="${yy}" stroke="#232c3d" stroke-width="1"/>
            <text x="${pad.left - 8}" y="${yy + 4}" fill="#5d6a80" font-size="11" text-anchor="end" font-family="monospace">$${v.toFixed(2)}</text>`;
  }).join('');

  const startEquity = data[0].equity;
  const lastEquity = data[data.length - 1].equity;
  const equityColor = lastEquity >= startEquity ? '#2fbf71' : '#e5484d';

  $('#equity-chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Bot equity versus benchmark">
      ${gridLines}
      ${benches.length > 1 ? `<path d="${line(data.map((d) => d.benchmarkIndexed))}" fill="none" stroke="#6b7a94" stroke-width="1.5" stroke-dasharray="5 4"/>` : ''}
      <path d="${line(equities)}" fill="none" stroke="${equityColor}" stroke-width="2"/>
      <text x="${pad.left}" y="${H - 8}" fill="#5d6a80" font-size="11" font-family="monospace">${esc(time(data[0].at))}</text>
      <text x="${W - pad.right}" y="${H - 8}" fill="#5d6a80" font-size="11" font-family="monospace" text-anchor="end">${esc(time(data[data.length - 1].at))}</text>
      <g font-size="11" font-family="monospace">
        <rect x="${pad.left + 8}" y="${pad.top + 4}" width="10" height="3" fill="${equityColor}"/>
        <text x="${pad.left + 24}" y="${pad.top + 10}" fill="#8b98b0">Bot equity</text>
        ${benches.length > 1 ? `<rect x="${pad.left + 108}" y="${pad.top + 4}" width="10" height="3" fill="#6b7a94"/>
        <text x="${pad.left + 124}" y="${pad.top + 10}" fill="#8b98b0">Benchmark</text>` : ''}
      </g>
    </svg>`;
}

/* ---------------------------------------------------------- approvals */

function renderApprovals() {
  const pending = state.proposals.filter((p) => p.needsApproval);
  const panel = $('#approval-panel');
  panel.hidden = pending.length === 0;
  if (pending.length === 0) return;

  $('#approval-list').innerHTML = pending.map((p) => `
    <div class="approval-card">
      <div class="approval-head">
        <div>
          <strong>${esc(p.ticker)}</strong> · BUY ${esc(p.amount)} · ~${p.shares.toFixed(6)} shares @ ${p.price.toFixed(2)}
          <div class="stat-sub">Expires ${esc(time(p.expiresAt))} · confidence ${(p.confidence * 100).toFixed(0)}%</div>
        </div>
        <div class="approval-actions">
          <button class="btn btn-ghost" data-review="${esc(p.proposalId)}">Review</button>
          <button class="btn btn-good" data-approve="${esc(p.proposalId)}">APPROVE</button>
          <button class="btn btn-danger" data-reject="${esc(p.proposalId)}">REJECT</button>
        </div>
      </div>
      <div class="stat-sub">${esc(p.rationale)}</div>
    </div>`).join('');

  $('#approval-list').querySelectorAll('[data-review]').forEach((b) =>
    b.addEventListener('click', () => openApproval(b.dataset.review)));
  $('#approval-list').querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => openApproval(b.dataset.approve)));
  $('#approval-list').querySelectorAll('[data-reject]').forEach((b) =>
    b.addEventListener('click', () => rejectProposal(b.dataset.reject)));
}

async function openApproval(proposalId) {
  try {
    const a = await api(`/api/proposals/${proposalId}/approval`);
    $('#modal-title').textContent = `Approve ${a.ticker} — ${a.dollarAmount}`;
    $('#modal-body').innerHTML = `
      <div class="kv">
        <div><div class="k">Ticker</div><div class="v">${esc(a.ticker)} — ${esc(a.companyName)}</div></div>
        <div><div class="k">Direction</div><div class="v">${esc(a.direction)} / ${esc(a.side)}</div></div>
        <div><div class="k">Dollar amount</div><div class="v">${esc(a.dollarAmount)}</div></div>
        <div><div class="k">Approximate shares</div><div class="v">${a.approximateShares.toFixed(6)}</div></div>
        <div><div class="k">Reference price</div><div class="v">${a.referencePrice.toFixed(2)}</div></div>
        <div><div class="k">Current price</div><div class="v ${signClass(a.priceDriftPct)}">${a.currentPrice ? a.currentPrice.toFixed(2) : '—'} (${pct(a.priceDriftPct)})</div></div>
        <div><div class="k">Signal</div><div class="v">${esc(a.signal.band)} ${a.signal.score > 0 ? '+' : ''}${a.signal.score}</div></div>
        <div><div class="k">Uncertainty</div><div class="v">${(a.signal.uncertainty * 100).toFixed(0)}%</div></div>
      </div>

      <h4 style="margin:16px 0 6px">Reasoning</h4>
      <div class="detail"><div class="why">${esc(a.signal.explanation)}</div><div>${esc(a.reasoning)}</div></div>

      <h4 style="margin:16px 0 6px">Sources (${a.sources.length})</h4>
      <div class="detail"><ul>${a.sources.map((s) => `
        <li><strong>@${esc(s.handle)}</strong> <span class="chip">${esc(s.tier)}</span>
        sentiment ${s.sentiment > 0 ? '+' : ''}${s.sentiment} · ${esc(time(s.postedAt))}<br/>${esc(s.excerpt)}</li>`).join('')}</ul></div>

      ${a.contradictoryEvidence.length ? `<h4 style="margin:16px 0 6px">Evidence against</h4>
      <div class="detail against"><ul>${a.contradictoryEvidence.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}

      <h4 style="margin:16px 0 6px">Current strategy P&amp;L</h4>
      <div class="kv">
        <div><div class="k">Starting capital</div><div class="v">${esc(a.strategyPnl.startingCapital)}</div></div>
        <div><div class="k">Cash</div><div class="v">${esc(a.strategyPnl.cash)}</div></div>
        <div><div class="k">Positions</div><div class="v">${esc(a.strategyPnl.positionsValue)}</div></div>
        <div><div class="k">Unrealised</div><div class="v">${esc(a.strategyPnl.unrealised)}</div></div>
        <div><div class="k">Realised</div><div class="v">${esc(a.strategyPnl.realised)}</div></div>
        <div><div class="k">Equity</div><div class="v">${esc(a.strategyPnl.equity)} (${pct(a.strategyPnl.totalReturnPct)})</div></div>
      </div>

      <h4 style="margin:16px 0 6px">Resulting exposure</h4>
      <div class="kv">
        <div><div class="k">Positions after</div><div class="v">${a.resultingExposure.openPositions + 1} / ${a.resultingExposure.maxPositions}</div></div>
        <div><div class="k">Exposure</div><div class="v">${a.resultingExposure.currentExposurePct.toFixed(1)}% → ${a.resultingExposure.exposureAfterPct.toFixed(1)}%</div></div>
        <div><div class="k">This position</div><div class="v">${a.resultingExposure.positionSizePctOfEquity.toFixed(1)}% of equity (cap ${a.resultingExposure.maxPositionPct}%)</div></div>
      </div>

      <h4 style="margin:16px 0 6px">Risk impact</h4>
      <div class="kv">
        <div><div class="k">Risk verdict</div><div class="v ${a.riskImpact.approved ? 'pos' : 'neg'}">${a.riskImpact.approved ? 'APPROVED' : 'REJECTED'}</div></div>
        <div><div class="k">Drawdown</div><div class="v">${a.riskImpact.drawdownPct.toFixed(2)}% / ${a.riskImpact.maxDrawdownPct}%</div></div>
        <div><div class="k">Daily loss</div><div class="v">${a.riskImpact.dailyLossPct.toFixed(2)}% / ${a.riskImpact.maxDailyLossPct}%</div></div>
      </div>
      <div class="detail"><ul>${a.riskImpact.checks.map((c) => `<li>${c.passed ? '✅' : '❌'} <strong>${esc(c.check)}</strong> — ${esc(c.detail)}</li>`).join('')}</ul></div>

      <h4 style="margin:16px 0 6px">Invalidation condition</h4>
      <div class="detail">${esc(a.invalidationCondition)}</div>

      ${a.blockReason ? `<div class="banner" style="margin-top:14px">${esc(a.blockReason)}</div>` : ''}

      <div class="approval-actions" style="margin-top:18px; justify-content:flex-end">
        <button class="btn btn-danger" id="modal-reject">REJECT</button>
        <button class="btn btn-good" id="modal-approve" ${a.actionable ? '' : 'disabled'}>APPROVE ${esc(a.dollarAmount)} ${esc(a.ticker)}</button>
      </div>
      <div class="stat-sub" style="text-align:right; margin-top:6px">
        Approval binds to fingerprint <span class="mono">${esc(a.approvalFingerprint)}</span>.
        If price or size moves before submission, the order is invalidated rather than executed.
      </div>`;

    $('#modal').classList.remove('hidden');
    $('#modal-approve')?.addEventListener('click', () => approveProposal(a.proposalId, a.approvalFingerprint));
    $('#modal-reject')?.addEventListener('click', () => rejectProposal(a.proposalId));
  } catch (e) {
    toast(`Could not load approval: ${e.message}`, 'bad');
  }
}

async function approveProposal(proposalId, fingerprint) {
  try {
    const result = await api(`/api/proposals/${proposalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvalFingerprint: fingerprint }),
    });
    toast(result.detail, result.ok ? 'good' : 'bad');
  } catch (e) {
    toast(`Approval failed: ${e.message}`, 'bad');
  }
  $('#modal').classList.add('hidden');
  await load();
}

async function rejectProposal(proposalId) {
  try {
    const result = await api(`/api/proposals/${proposalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ note: 'Rejected from Trading Lab' }),
    });
    toast(result.detail, 'good');
  } catch (e) {
    toast(`Rejection failed: ${e.message}`, 'bad');
  }
  $('#modal').classList.add('hidden');
  await load();
}

/* ------------------------------------------------------------ signals */

function renderSignals() {
  const rows = state.signalFeed;
  $('#feed-note').textContent = `${rows.length} recent · click a row for the full explanation`;
  const tbody = $('#signal-table tbody');

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No signals yet. Run a cycle.</td></tr>';
    $('#signal-detail').innerHTML = '';
    return;
  }

  tbody.innerHTML = rows.map((s) => `
    <tr data-signal="${esc(s.signalId)}" class="${s.signalId === selectedSignalId ? 'selected' : ''}">
      <td><strong>${esc(s.ticker)}</strong></td>
      <td><span class="chip ${bandClass(s.band)}">${esc(s.bandLabel)}</span></td>
      <td class="num ${signClass(s.score)}">${s.score > 0 ? '+' : ''}${s.score}</td>
      <td class="num">${s.sourceCount} (${s.independentSourceCount.toFixed(1)} ind.)</td>
      <td class="num">${(s.uncertainty * 100).toFixed(0)}%</td>
      <td>${esc(time(s.timestamp))}</td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-signal]').forEach((tr) =>
    tr.addEventListener('click', () => { selectedSignalId = tr.dataset.signal; renderSignals(); }));

  const selected = rows.find((s) => s.signalId === selectedSignalId) ?? rows[0];
  selectedSignalId = selected.signalId;
  renderSignalDetail(selected);
  $('#btn-audit').disabled = false;
}

function renderSignalDetail(s) {
  const componentBars = Object.entries(s.components).map(([name, value]) => {
    const directional = name === 'sentiment' || name === 'priceConfirmation';
    const width = directional ? Math.abs(value) / 2 : value;
    const cls = directional ? (value >= 0 ? 'pos' : 'neg') : '';
    return `<div class="bar-row">
      <span>${esc(name)}</span>
      <span class="bar-track"><span class="bar-fill ${cls}" style="width:${Math.min(100, width)}%"></span></span>
      <span class="num">${value > 0 && directional ? '+' : ''}${value}</span>
    </div>`;
  }).join('');

  $('#signal-detail').innerHTML = `
    <h4>${esc(s.ticker)} — ${esc(s.bandLabel)} ${s.score > 0 ? '+' : ''}${s.score}</h4>
    <div class="why">${esc(s.why)}</div>
    <h4>Components</h4>
    <div class="bars">${componentBars}</div>
    <h4>Where the points came from</h4>
    <ul>${s.topContributions.map((c) => `<li>${esc(c.explanation)}</li>`).join('')}</ul>
    ${s.supporting.length ? `<h4>Supporting evidence</h4><ul>${s.supporting.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${s.contradictory.length ? `<h4>Contradictory evidence</h4><ul class="against">${s.contradictory.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}`;
}

/* --------------------------------------------------------- audit view */

const DISPOSITION_LABEL = {
  PROPOSED: 'Became a trade proposal',
  AWAITING_LIVE_APPROVAL: 'Held for human approval (LIVE)',
  RISK_REJECTED: 'Blocked by the risk engine',
  BELOW_SIGNAL_THRESHOLD: 'Score below the trading threshold',
  NOT_LONG: 'Not bullish — v1 is long-only',
  SECURITY_UNAVAILABLE: 'Security left the permitted universe',
  NO_MARKET_PRICE: 'No market price available',
  NOT_SIZEABLE: 'Could not be sized into a tradable position',
  STRATEGY_RISK_BREACH: 'Strategy-level risk limit was breached',
  NO_RECORD: 'No disposition recorded',
};

async function openAudit(signalId) {
  try {
    const a = await api(`/api/signals/${signalId}/audit`);
    const s = a.signal;
    const traded = a.outcome.disposition === 'PROPOSED';
    const blocked = ['RISK_REJECTED', 'STRATEGY_RISK_BREACH', 'SECURITY_UNAVAILABLE'].includes(a.outcome.disposition);

    $('#modal-title').textContent = `Audit — ${s.ticker} ${s.score > 0 ? '+' : ''}${s.score} (${s.band})`;
    $('#modal-body').innerHTML = `
      <div class="audit-verdict ${traded ? 'traded' : blocked ? 'blocked' : ''}">
        <strong>${esc(DISPOSITION_LABEL[a.outcome.disposition] ?? a.outcome.disposition)}</strong>
        <div class="stat-sub" style="margin-top:4px">${esc(a.outcome.detail)}</div>
        <ol>${a.outcome.narrative.map((n) => `<li>${esc(n)}</li>`).join('')}</ol>
      </div>

      <div class="audit-section">
        <h4>Score composition</h4>
        <div class="table-scroll"><table class="grid">
          <thead><tr><th>Dimension</th><th class="num">Value</th><th class="num">Points</th><th>Why</th></tr></thead>
          <tbody>${a.components.map((c) => `<tr>
            <td>${esc(c.name)}${c.directional ? ' <span class="chip">directional</span>' : ''}</td>
            <td class="num">${c.value}</td>
            <td class="num ${signClass(c.contributionPoints)}">${c.contributionPoints > 0 ? '+' : ''}${c.contributionPoints}</td>
            <td>${esc(c.explanation)}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="stat-sub" style="margin-top:6px">
          Final score ${s.score} · uncertainty ${(a.uncertainty * 100).toFixed(0)}%
        </div>
      </div>

      <div class="audit-section">
        <h4>Entity resolution</h4>
        <div class="kv">
          <div><div class="k">Minimum confidence</div><div class="v ${a.resolution.passesThreshold ? 'pos' : 'neg'}">${(a.resolution.minConfidence * 100).toFixed(0)}%</div></div>
          <div><div class="k">Tradable threshold</div><div class="v">${(a.resolution.tradableThreshold * 100).toFixed(0)}%</div></div>
          <div><div class="k">Verdict</div><div class="v ${a.resolution.passesThreshold ? 'pos' : 'neg'}">${a.resolution.passesThreshold ? 'USABLE' : 'TOO AMBIGUOUS'}</div></div>
        </div>
      </div>

      <div class="audit-section">
        <h4>Source posts (${a.sources.length})</h4>
        ${a.sources.map((src) => `
          <div class="audit-source ${src.filterVerdict === 'REJECT' ? 'rejected' : ''}">
            <div class="meta">
              <strong>@${esc(src.handle)}</strong> · <span class="chip">${esc(src.sourceTier.replace('_', ' '))}</span>
              ${esc(src.sourceClass.replace(/_/g, ' ').toLowerCase())} ·
              posted ${esc(time(src.postedAt))} · seen ${esc(time(src.capturedAt))} ·
              weight ${src.weight} ·
              sentiment ${src.sentiment > 0 ? '+' : ''}${src.sentiment} ·
              ${esc(src.eventType.replace(/_/g, ' ').toLowerCase())}
              ${src.filterVerdict && src.filterVerdict !== 'ACCEPT' ? ` · <span class="neg">${esc(src.filterVerdict)}: ${esc(src.filterReasons.join(', '))}</span>` : ''}
            </div>
            <div>${esc(src.text)}</div>
            <div class="meta" style="margin-top:4px">
              ${src.resolution
                ? `resolved via ${esc(src.resolution.method)} @ ${(src.resolution.confidence * 100).toFixed(0)}% on "${esc(src.resolution.matchedText)}"${src.resolution.competingSecurityIds.length ? ` · competing: ${esc(src.resolution.competingSecurityIds.join(', '))}` : ''}`
                : 'no resolution recorded for this security'}
              · ♥ ${src.engagement.likes} ⇄ ${src.engagement.reposts}
              · <a href="${esc(src.url)}" target="_blank" rel="noopener">post</a>
            </div>
          </div>`).join('')}
      </div>

      ${a.priceConfirmation ? `<div class="audit-section">
        <h4>Price confirmation</h4>
        <div class="kv">
          <div><div class="k">Last price</div><div class="v">${a.priceConfirmation.lastPrice.toFixed(2)}</div></div>
          <div><div class="k">Momentum</div><div class="v ${signClass(a.priceConfirmation.momentumPct)}">${pct(a.priceConfirmation.momentumPct)}</div></div>
          <div><div class="k">Abnormal move</div><div class="v">${a.priceConfirmation.abnormalMoveZ.toFixed(2)}σ</div></div>
          <div><div class="k">Volume ratio</div><div class="v">${a.priceConfirmation.abnormalVolumeRatio === null ? 'n/a' : `${a.priceConfirmation.abnormalVolumeRatio.toFixed(2)}x`}</div></div>
          <div><div class="k">vs benchmark</div><div class="v ${signClass(a.priceConfirmation.marketRelativePct)}">${pct(a.priceConfirmation.marketRelativePct)}</div></div>
          <div><div class="k">Data age</div><div class="v ${a.priceConfirmation.stale ? 'neg' : ''}">${a.priceConfirmation.dataAgeMinutes.toFixed(0)}m${a.priceConfirmation.stale ? ' STALE' : ''}</div></div>
        </div>
      </div>` : '<div class="audit-section"><h4>Price confirmation</h4><div class="empty">No market data was available; the price adjustment was withheld and uncertainty raised.</div></div>'}

      ${a.contradictoryEvidence.length ? `<div class="audit-section">
        <h4>Evidence against</h4>
        <div class="detail against"><ul>${a.contradictoryEvidence.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>
      </div>` : ''}

      ${a.forwardReturns.some((f) => f.forwardReturnPct !== null) ? `<div class="audit-section">
        <h4>Forward returns</h4>
        <div class="table-scroll"><table class="grid">
          <thead><tr><th>Horizon</th><th class="num">Return</th><th class="num">Excess</th><th>Hit</th></tr></thead>
          <tbody>${a.forwardReturns.map((f) => `<tr>
            <td>${esc(f.horizon)}</td>
            <td class="num ${signClass(f.forwardReturnPct)}">${pct(f.forwardReturnPct)}</td>
            <td class="num ${signClass(f.excessReturnPct)}">${pct(f.excessReturnPct)}</td>
            <td>${f.hit === null ? '—' : f.hit ? '✅' : '❌'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>` : ''}`;

    $('#modal').classList.remove('hidden');
  } catch (e) {
    toast(`Could not load audit: ${e.message}`, 'bad');
  }
}

/* ---------------------------------------------------------- proposals */

function renderProposals() {
  const tbody = $('#proposal-table tbody');
  if (state.proposals.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No proposals yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.proposals.map((p) => `
    <tr title="${esc(p.riskSummary)}">
      <td><strong>${esc(p.ticker)}</strong></td>
      <td class="num">${esc(p.amount)}</td>
      <td class="num">${p.shares.toFixed(4)}</td>
      <td><span class="chip ${p.status === 'FILLED' ? 'chip-good' : p.status === 'RISK_REJECTED' || p.status === 'FAILED' ? 'chip-bad' : p.status === 'AWAITING_APPROVAL' ? 'chip-warn' : ''}">${esc(p.status)}</span></td>
      <td>${p.riskApproved === null ? '—' : p.riskApproved ? '<span class="pos">pass</span>' : `<span class="neg">${esc(p.failedChecks.slice(0, 2).join(', '))}</span>`}</td>
      <td>${esc(time(p.createdAt))}</td>
    </tr>`).join('');
}

/* ---------------------------------------------------------- positions */

function renderPositions() {
  const tbody = $('#position-table tbody');
  if (state.openPositions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No open positions.</td></tr>';
    return;
  }
  tbody.innerHTML = state.openPositions.map((p) => `
    <tr title="${esc(p.invalidation)}">
      <td><strong>${esc(p.ticker)}</strong></td>
      <td class="num">${p.quantity.toFixed(4)}</td>
      <td class="num">${p.entryPrice.toFixed(2)}</td>
      <td class="num">${p.lastPrice.toFixed(2)}</td>
      <td class="num">${esc(p.marketValue)}</td>
      <td class="num ${signClass(p.unrealisedPct)}">${esc(p.unrealised)} (${pct(p.unrealisedPct)})</td>
      <td class="num">${p.heldHours.toFixed(1)}h</td>
    </tr>`).join('');
}

function renderTrades() {
  const tbody = $('#trade-table tbody');
  if (state.recentTrades.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No closed trades yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.recentTrades.map((t) => `
    <tr title="${esc(t.exitNote || '')}">
      <td><strong>${esc(t.ticker)}</strong></td>
      <td class="num">${t.entryPrice.toFixed(2)}</td>
      <td class="num">${t.exitPrice ? t.exitPrice.toFixed(2) : '—'}</td>
      <td class="num ${signClass(t.realisedPct)}">${esc(t.realised)} (${pct(t.realisedPct)})</td>
      <td class="num">${t.holdingHours ? `${t.holdingHours.toFixed(1)}h` : '—'}</td>
      <td>${esc(t.exitReason || '—')}</td>
    </tr>`).join('');
}

/* --------------------------------------------------------- analytics */

function bucketTable(rows, label) {
  if (!rows || rows.length === 0) return `<div class="empty">No ${label} data yet.</div>`;
  return `<div class="table-scroll"><table class="grid">
    <thead><tr><th>${esc(label)}</th><th class="num">N</th><th class="num">Hit rate</th><th class="num">Mean excess</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.bucket)}</td>
      <td class="num">${r.count}</td>
      <td class="num">${r.hitRatePct === null ? '—' : `${r.hitRatePct.toFixed(0)}%`}</td>
      <td class="num ${signClass(r.meanExcessReturnPct)}">${r.meanExcessReturnPct === null ? '—' : pct(r.meanExcessReturnPct)}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function renderPerformance() {
  const p = state.signalPerformance;
  $('#perf-caveat').textContent = p.caveat;
  $('#signal-performance').innerHTML = `
    <div class="kv" style="margin-bottom:12px">
      <div><div class="k">Measured signals (${esc(p.horizon)})</div><div class="v">${p.measuredSignals}</div></div>
      <div><div class="k">Hit rate</div><div class="v">${p.hitRatePct === null ? '—' : `${p.hitRatePct.toFixed(1)}%`}</div></div>
      <div><div class="k">Mean return</div><div class="v ${signClass(p.meanReturnPct)}">${pct(p.meanReturnPct)}</div></div>
      <div><div class="k">Mean excess</div><div class="v ${signClass(p.meanExcessReturnPct)}">${pct(p.meanExcessReturnPct)}</div></div>
    </div>
    ${!p.sampleAdequate ? `<div class="banner" style="background:rgba(232,163,61,0.1);border-color:rgba(232,163,61,0.35);color:#f0c586">${esc(p.caveat)}</div>` : ''}
    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">Strong vs weak signals</h4>
    ${bucketTable(p.byStrength, 'Strength')}
    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">By band</h4>
    ${bucketTable(p.byBand, 'Band')}
    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">Component contribution to forward return</h4>
    <div class="table-scroll"><table class="grid">
      <thead><tr><th>Component</th><th class="num">r</th><th>Interpretation</th></tr></thead>
      <tbody>${p.componentCorrelations.map((c) => `<tr>
        <td>${esc(c.component)}</td>
        <td class="num ${signClass(c.correlation)}">${c.correlation === null ? '—' : c.correlation.toFixed(3)}</td>
        <td>${esc(c.interpretation)}</td>
      </tr>`).join('')}</tbody></table></div>`;
}

function renderSources() {
  const s = state.sourceAnalytics;
  $('#source-analytics').innerHTML = `
    <h4 style="margin:0 0 6px; font-size:12px; color:var(--text-dim)">By source tier</h4>
    ${bucketTable(s.bySourceTier, 'Tier')}
    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">By account</h4>
    ${bucketTable(s.byAccount, 'Account')}
    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">By event type</h4>
    ${bucketTable(s.byEventType, 'Event type')}`;
}

/* --------------------------------------------------------------- risk */

function renderRisk() {
  const r = state.risk;
  $('#risk-note').textContent = r.ledger.integrityOk ? 'Ledger reconciles' : r.ledger.integrityDetail;

  $('#risk-panel').innerHTML = `
    <div class="kv" style="margin-bottom:14px">
      <div><div class="k">Starting capital</div><div class="v">${esc(r.ledger.startingCapital)}</div></div>
      <div><div class="k">Cash</div><div class="v">${esc(r.ledger.cash)}</div></div>
      <div><div class="k">Reserved</div><div class="v">${esc(r.ledger.reserved)}</div></div>
      <div><div class="k">Positions</div><div class="v">${esc(r.ledger.positions)}</div></div>
      <div><div class="k">Unrealised P&amp;L</div><div class="v">${esc(r.ledger.unrealised)}</div></div>
      <div><div class="k">Realised P&amp;L</div><div class="v">${esc(r.ledger.realised)}</div></div>
      <div><div class="k">Equity</div><div class="v">${esc(r.ledger.equity)}</div></div>
      <div><div class="k">Ledger integrity</div><div class="v ${r.ledger.integrityOk ? 'pos' : 'neg'}">${r.ledger.integrityOk ? 'OK' : 'MISMATCH'}</div></div>
    </div>

    <div class="kv" style="margin-bottom:14px">
      <div><div class="k">Daily loss</div><div class="v ${r.dailyLossPct >= r.maxDailyLossPct ? 'neg' : ''}">${r.dailyLossPct.toFixed(2)}% / ${r.maxDailyLossPct}%</div></div>
      <div><div class="k">Drawdown</div><div class="v ${r.drawdownPct >= r.maxDrawdownPct ? 'neg' : ''}">${r.drawdownPct.toFixed(2)}% / ${r.maxDrawdownPct}%</div></div>
      <div><div class="k">Risk interventions today</div><div class="v">${r.riskInterventionsToday}</div></div>
      <div><div class="k">Provider failures</div><div class="v">${Object.entries(r.failureCounts).map(([k, v]) => `${k}:${v}`).join(' · ')}</div></div>
    </div>

    ${r.openIncidents.length ? `<h4 style="margin:0 0 6px; font-size:12px; color:var(--text-dim)">Open incidents</h4>
    <div class="detail"><ul>${r.openIncidents.map((i) => `<li><strong>${esc(i.fault)}</strong> ${esc(time(i.at))} — ${esc(i.detail)}</li>`).join('')}</ul></div>` : ''}

    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">Recent risk rejections</h4>
    ${r.recentRejections.length === 0 ? '<div class="empty">No rejections today.</div>' : `<div class="table-scroll"><table class="grid">
      <thead><tr><th>Ticker</th><th>Failed checks</th><th>When</th></tr></thead>
      <tbody>${r.recentRejections.map((x) => `<tr>
        <td><strong>${esc(x.ticker)}</strong></td>
        <td class="neg">${esc(x.failedChecks.join(', '))}</td>
        <td>${esc(time(x.at))}</td>
      </tr>`).join('')}</tbody></table></div>`}

    <h4 style="margin:14px 0 6px; font-size:12px; color:var(--text-dim)">Active limits</h4>
    <div class="kv">
      ${Object.entries(r.limits).map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div></div>`).join('')}
    </div>`;
}

/* ------------------------------------------------------------ actions */

$('#btn-refresh').addEventListener('click', load);
$('#btn-audit').addEventListener('click', () => { if (selectedSignalId) openAudit(selectedSignalId); });

$('#btn-cycle').addEventListener('click', async () => {
  const btn = $('#btn-cycle');
  btn.disabled = true;
  btn.textContent = 'Running…';
  try {
    const report = await api('/api/control/cycle', { method: 'POST' });
    toast(
      `Cycle done: ${report.signalsGenerated} signals, ${report.proposalsCreated} proposals, ` +
      `${report.ordersSubmitted} orders, ${report.exitsTriggered.length} exits` +
      (report.errors.length ? ` · ${report.errors.length} error(s)` : ''),
      report.errors.length ? 'bad' : 'good',
    );
  } catch (e) {
    toast(`Cycle failed: ${e.message}`, 'bad');
  }
  btn.disabled = false;
  btn.textContent = 'Run cycle';
  await load();
});

$('#btn-kill').addEventListener('click', async () => {
  const reason = prompt('Reason for KILL BOT?', 'Manual stop from Trading Lab');
  if (reason === null) return;
  const liquidate = confirm(
    'Also LIQUIDATE all open positions?\n\n' +
    'OK = stop the bot AND sell every open position.\n' +
    'Cancel = stop new orders only, leave existing positions untouched (recommended).',
  );
  try {
    const result = await api('/api/control/kill', { method: 'POST', body: JSON.stringify({ reason, liquidate }) });
    toast(`Bot killed. ${result.cancelled.cancelled.length} order(s) cancelled.${liquidate ? ' Positions will be liquidated on the next cycle.' : ''}`, 'bad');
  } catch (e) {
    toast(`Kill failed: ${e.message}`, 'bad');
  }
  await load();
});

$('#btn-resume').addEventListener('click', async () => {
  const note = prompt('Note for the resume?', 'Fault cleared');
  if (note === null) return;
  try {
    await api('/api/control/resume', { method: 'POST', body: JSON.stringify({ note }) });
    toast('Strategy resumed.', 'good');
  } catch (e) {
    toast(`Resume failed: ${e.message}`, 'bad');
  }
  await load();
});

$('#modal-close').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });

load();
setInterval(load, 30_000);
