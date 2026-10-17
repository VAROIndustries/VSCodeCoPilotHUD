// Pure logic + panel HTML. No vscode import, so test.js can run it in plain node.
const QUOTAS = [['premium_interactions', 'Premium requests', 'premium'], ['chat', 'Chat', 'chat'], ['completions', 'Completions', 'completions']];
const DAY = 864e5;
const ALERT_LEVELS = [90, 75];

const clamp = (x) => Math.max(0, Math.min(100, x));
const bar = (pct, w = 10) => { const n = Math.round(pct / 100 * w); return '▰'.repeat(n) + '▱'.repeat(w - n); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtDate = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// billing cycle = the month before the reset date
function cycle(data, now = Date.now()) {
  const end = new Date(data.quota_reset_date_utc || data.quota_reset_date);
  if (isNaN(end)) return null;
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - 1);
  return { start: +start, end: +end, pct: clamp((now - start) / (end - start) * 100), day: Math.ceil((now - start) / DAY), days: Math.round((end - start) / DAY) };
}

function quotas(data) {
  return QUOTAS.map(([key, name, short], i) => {
    const q = data.quota_snapshots?.[key];
    if (!q) return null;
    const base = { key, name, short, slot: i + 1 };
    if (q.unlimited) return { ...base, unlimited: true };
    if (!q.has_quota || !q.entitlement) return { ...base, included: false };
    return { ...base, included: true, used: clamp(100 - q.percent_remaining), remaining: Math.max(0, Math.round(q.remaining)), entitlement: q.entitlement, overage: q.overage_count || 0 };
  }).filter(Boolean);
}

// straight-line burn rate: used% / cycle%. status: idle | cool | pace | hot
function forecast(q, cyc, now = Date.now()) {
  if (!q.included || !cyc) return null;
  if (q.used >= 100) return { status: 'hot', projected: 100, runOut: null, out: true };
  if (q.used === 0) return { status: 'idle', projected: 0, runOut: null };
  if (now - cyc.start < DAY) return { status: q.used >= 80 ? 'hot' : 'cool', projected: null, runOut: null }; // ponytail: <1 day of data is too noisy to project
  const projected = q.used / cyc.pct * 100;
  const runOut = projected > 100 ? cyc.start + (cyc.end - cyc.start) * (cyc.pct / q.used) : null;
  return { status: projected >= 100 ? 'hot' : projected >= 80 ? 'pace' : 'cool', projected, runOut };
}

function forecastText(f, cyc) {
  if (!f) return '';
  if (f.out) return 'Quota used up';
  if (f.status === 'idle') return 'No usage yet this cycle';
  if (f.projected == null) return 'Too early to project';
  if (f.runOut) return `Runs out ~${fmtDate(new Date(f.runOut))}, ${Math.round((cyc.end - f.runOut) / DAY)}d before reset`;
  return `On track for ~${Math.round(f.projected)}% by reset`;
}

// status bar text + markdown tooltip
function render(data, now = Date.now()) {
  const list = quotas(data), cyc = cycle(data, now);
  const rows = [];
  let worst = null;
  for (const q of list) {
    if (q.unlimited) { rows.push(`${q.short.padEnd(12)}${'∞'.padStart(10)}  unlimited`); continue; }
    if (!q.included) continue;
    rows.push(`${q.short.padEnd(12)}${bar(q.used)} ${String(Math.round(q.used)).padStart(3)}%  ${q.remaining}/${q.entitlement} left` + (q.overage ? `  +${q.overage} overage` : ''));
    if (!worst || q.used > worst.used) worst = q;
  }
  if (cyc) rows.push(`${'cycle'.padEnd(12)}${bar(cyc.pct)} ${String(Math.round(cyc.pct)).padStart(3)}%  resets ${data.quota_reset_date}`);
  const f = worst && forecast(worst, cyc, now);
  const text = worst ? `$(copilot) ${worst.short} ${bar(worst.used, 5)} ${Math.round(worst.used)}%${f?.status === 'hot' ? ' $(flame)' : ''}` : '$(copilot) ∞';
  const level = !worst ? 'ok' : worst.used >= 80 ? 'error' : worst.used >= 60 ? 'warning' : 'ok';
  const tooltip = `**Copilot usage** — ${data.copilot_plan ?? '?'} plan\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n\n${f ? forecastText(f, cyc) + ' · ' : ''}Click for dashboard.`;
  return { text, tooltip, level };
}

// one alert per quota per level per cycle. state: { cycle, levels: { key: highestAlerted } }
function alerts(state, list, cycleKey) {
  const levels = state?.cycle === cycleKey ? { ...state.levels } : {};
  const fire = [];
  for (const q of list) {
    if (!q.included) continue;
    const lvl = ALERT_LEVELS.find((l) => q.used >= l) || 0;
    if (lvl > (levels[q.key] || 0)) { fire.push({ name: q.name, level: lvl, used: q.used, remaining: q.remaining }); levels[q.key] = lvl; }
  }
  return { fire, state: { cycle: cycleKey, levels } };
}

// ponytail: one sample per 30 min (or on change), current cycle only, capped at 2000; enough for a month of hourly points
function record(history, list, now, cycleStart) {
  const u = Object.fromEntries(list.filter((q) => q.included).map((q) => [q.key, +q.used.toFixed(2)]));
  const h = (history || []).filter((s) => s.t >= cycleStart);
  const last = h[h.length - 1];
  if (last && now - last.t < 30 * 60e3 && JSON.stringify(last.u) === JSON.stringify(u)) return h;
  return [...h, { t: now, u }].slice(-2000);
}

// ---------- panel ----------
const STATUS = {
  idle: ['●', 'Idle', 'good'], cool: ['▼', 'Cool', 'good'],
  pace: ['■', 'On pace', 'warning'], hot: ['▲', 'Hot', 'critical'],
};

function ring(q, cyc) {
  const r = 52, c = 2 * Math.PI * r;
  const tick = cyc ? (cyc.pct / 100) * 2 * Math.PI - Math.PI / 2 : null;
  const tx = (rad) => (60 + Math.cos(tick) * rad).toFixed(1), ty = (rad) => (60 + Math.sin(tick) * rad).toFixed(1);
  return `<svg class="ring" viewBox="0 0 120 120" role="img" aria-label="${esc(q.name)} ${Math.round(q.used)}% used">
    <circle cx="60" cy="60" r="${r}" class="track s${q.slot}"/>
    ${q.used > 0 ? `<circle cx="60" cy="60" r="${r}" class="fill s${q.slot}" stroke-dasharray="${(q.used / 100 * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>` : ''}
    ${tick != null ? `<line x1="${tx(44)}" y1="${ty(44)}" x2="${tx(62)}" y2="${ty(62)}" class="tick"><title>Cycle ${Math.round(cyc.pct)}% elapsed</title></line>` : ''}
    <text x="60" y="60" class="big">${Math.round(q.used)}%</text>
    <text x="60" y="80" class="small">used</text>
  </svg>`;
}

function card(q, cyc, now) {
  if (q.unlimited) return `<div class="card"><h3><span class="dot s${q.slot}"></span>${esc(q.name)}</h3><div class="inf">∞</div><p class="muted">Unlimited on your plan</p></div>`;
  if (!q.included) return `<div class="card off"><h3><span class="dot s${q.slot}"></span>${esc(q.name)}</h3><p class="muted">Not included in your plan</p></div>`;
  const f = forecast(q, cyc, now);
  const [icon, label, tone] = STATUS[f?.status || 'idle'];
  return `<div class="card">
    <h3><span class="dot s${q.slot}"></span>${esc(q.name)}</h3>
    ${ring(q, cyc)}
    <p class="num"><b>${q.remaining.toLocaleString()}</b> of ${q.entitlement.toLocaleString()} left${q.overage ? ` · <b>+${q.overage}</b> overage` : ''}</p>
    <p class="badge ${tone}"><span aria-hidden="true">${icon}</span> ${label}</p>
    <p class="muted">${esc(forecastText(f, cyc))}</p>
  </div>`;
}

function chart(list, history, cyc, now) {
  const series = list.filter((q) => q.included);
  if (!cyc || !series.length) return '';
  const W = 640, H = 220, L = 36, R = 92, T = 12, B = 26;
  const x = (t) => L + (t - cyc.start) / (cyc.end - cyc.start) * (W - L - R);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}%</text>`).join('');
  const xt = [cyc.start, (cyc.start + cyc.end) / 2, cyc.end].map((t, i) => `<text x="${x(t)}" y="${H - 6}" class="axis" text-anchor="${['start', 'middle', 'end'][i]}">${fmtDate(new Date(t))}</text>`).join('');
  const pace = `<line x1="${x(cyc.start)}" y1="${y(0)}" x2="${x(cyc.end)}" y2="${y(100)}" class="pace"/><text x="${x(cyc.end) + 6}" y="${y(100) + 4}" class="axis">pace</text>`;
  const nowLine = `<line x1="${x(now)}" x2="${x(now)}" y1="${T}" y2="${H - B}" class="now"/>`;
  // end labels: top-to-bottom, pushed apart so near-equal values don't overlap
  const ly = {};
  let prev = -Infinity;
  const order = [...series].sort((a, b) => b.used - a.used);
  for (const q of order) prev = ly[q.key] = Math.max(y(q.used) + 4, prev + 14);
  let next = H - B + 4; // then pull the stack up so nothing drops below the x axis
  for (const q of order.reverse()) {
    ly[q.key] = Math.min(ly[q.key], next);
    next = ly[q.key] - 14;
  }
  const lines = series.map((q) => {
    const pts = [...(history || []).filter((s) => s.u[q.key] != null).map((s) => [s.t, s.u[q.key]]), [now, q.used]];
    const d = pts.map(([t, v]) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const hits = pts.map(([t, v]) => `<circle cx="${x(t).toFixed(1)}" cy="${y(v).toFixed(1)}" r="7" class="hit"><title>${esc(q.name)}: ${v.toFixed(1)}% · ${new Date(t).toLocaleString()}</title></circle>`).join('');
    const [ex, ey] = [x(now), y(q.used)];
    return `<polyline points="${d}" class="line s${q.slot}"/>${hits}<circle cx="${ex}" cy="${ey}" r="4" class="end s${q.slot}"/><text x="${W - R + 6}" y="${ly[q.key]}" class="lbl">${esc(q.short)} ${Math.round(q.used)}%</text>`;
  }).join('');
  const legend = series.map((q) => `<span><span class="dot s${q.slot}"></span>${esc(q.name)}</span>`).join('') + '<span><span class="dash"></span>Even pace</span>';
  return `<section class="chartbox"><h2>This cycle</h2><div class="legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Usage percent over the billing cycle">${grid}${xt}${pace}${nowLine}${lines}</svg>
    <p class="muted">Lines above the dashed pace line are burning faster than the cycle. History builds up as VS Code refreshes.</p></section>`;
}

function panelHtml({ data, history, now = Date.now(), nonce = '', cspSource = '' }) {
  const list = quotas(data), cyc = cycle(data, now);
  const updated = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'nonce-${nonce}';">
<style>
  :root{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--good:#0ca30c;--warning:#b07800;--critical:#d03b3b}
  body.vscode-dark,body.vscode-high-contrast{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--good:#0ca30c;--warning:#fab219;--critical:#e66767}
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px 24px;max-width:980px}
  header{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;margin-bottom:20px}
  h1{font-size:20px;margin:0;font-weight:600} h2{font-size:14px;margin:0 0 8px;font-weight:600} h3{font-size:13px;margin:0 0 6px;font-weight:600;display:flex;align-items:center;gap:6px}
  .muted{color:var(--vscode-descriptionForeground);font-size:12px;margin:4px 0 0}
  .cyc{flex:1;min-width:220px} .meter{height:8px;border-radius:4px;background:color-mix(in srgb,var(--vscode-foreground) 12%,transparent);overflow:hidden;margin-top:6px}
  .meter i{display:block;height:100%;border-radius:4px;background:var(--vscode-descriptionForeground)}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit}
  button:hover{background:var(--vscode-button-hoverBackground)}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
  .card{border:1px solid var(--vscode-panel-border,#8884);border-radius:8px;padding:14px;text-align:center}
  .card h3{justify-content:center} .card.off{opacity:.65;display:flex;flex-direction:column;justify-content:center;min-height:120px}
  .ring{width:132px;height:132px;display:block;margin:4px auto}
  .track{fill:none;stroke-width:10;stroke:currentColor;opacity:.16} .fill{fill:none;stroke-width:10;stroke-linecap:round;stroke:currentColor}
  .tick{stroke:var(--vscode-foreground);stroke-width:2;stroke-linecap:round}
  .big{font-size:24px;font-weight:600;fill:var(--vscode-foreground);text-anchor:middle} .small{font-size:11px;fill:var(--vscode-descriptionForeground);text-anchor:middle}
  .s1{color:var(--s1)} .s2{color:var(--s2)} .s3{color:var(--s3)}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:currentColor}
  .num{margin:4px 0;font-size:13px} .inf{font-size:48px;line-height:132px}
  .badge{display:inline-block;margin:6px 0 0;font-size:12px;font-weight:600;padding:2px 10px;border-radius:10px;border:1px solid currentColor}
  .badge.good{color:var(--good)} .badge.warning{color:var(--warning)} .badge.critical{color:var(--critical)}
  .chartbox{border:1px solid var(--vscode-panel-border,#8884);border-radius:8px;padding:14px}
  .legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;margin-bottom:6px} .legend>span{display:flex;align-items:center;gap:6px}
  .dash{display:inline-block;width:18px;border-top:2px dashed var(--vscode-descriptionForeground)}
  .chart{width:100%;height:auto} .grid{stroke:var(--vscode-foreground);opacity:.1} .axis{font-size:10px;fill:var(--vscode-descriptionForeground)}
  .pace{stroke:var(--vscode-descriptionForeground);stroke-width:1.5;stroke-dasharray:4 4} .now{stroke:var(--vscode-foreground);opacity:.25}
  .line{fill:none;stroke:currentColor;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
  .end{fill:currentColor;stroke:var(--vscode-editor-background);stroke-width:2} .hit{fill:transparent}
  .lbl{font-size:11px;fill:var(--vscode-foreground)}
</style></head><body>
<header>
  <h1>Copilot usage</h1>
  <span class="muted">${esc(data.copilot_plan ?? '?')} plan · updated ${esc(updated)}</span>
  ${cyc ? `<div class="cyc"><div class="muted">Cycle day ${cyc.day} of ${cyc.days} · resets ${esc(fmtDate(new Date(cyc.end)))}</div><div class="meter" role="img" aria-label="Cycle ${Math.round(cyc.pct)}% elapsed"><i style="width:${cyc.pct.toFixed(1)}%"></i></div></div>` : ''}
  <button id="r">Refresh</button>
</header>
<div class="cards">${list.map((q) => card(q, cyc, now)).join('')}</div>
${chart(list, history, cyc, now)}
<p class="muted">The tick on each ring marks how far through the cycle you are. Fill past the tick = ahead of pace.</p>
<script nonce="${nonce}">const v=acquireVsCodeApi();document.getElementById('r').onclick=()=>v.postMessage('refresh');</script>
</body></html>`;
}

module.exports = { render, cycle, quotas, forecast, forecastText, alerts, record, panelHtml };
