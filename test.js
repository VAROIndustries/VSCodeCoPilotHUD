const assert = require('assert');
const hud = require('./hud');
const fx = require('./fixture.json');
const now = Date.parse('2026-10-16T12:00:00Z');
const DAY = 864e5;

// real fixture: premium has no quota on this plan -> hidden, not "100% used"
let r = hud.render(fx, now);
assert.ok(!r.tooltip.includes('premium'), 'premium with entitlement 0 must be hidden');
assert.match(r.tooltip, /chat\s+▱{10}\s+0%\s+200\/200 left/);
assert.match(r.tooltip, /completions\s+▱{10}\s+0%/);
assert.match(r.tooltip, /resets 2026-11-01/);
assert.strictEqual(r.level, 'ok');
assert.strictEqual(hud.quotas(fx).find((q) => q.key === 'premium_interactions').included, false);

// heavy usage -> worst quota in status text + error level + flame; overage clamps
const hot = structuredClone(fx);
Object.assign(hot.quota_snapshots.chat, { percent_remaining: 10, remaining: 20 });
Object.assign(hot.quota_snapshots.premium_interactions, { has_quota: true, entitlement: 300, remaining: -5, percent_remaining: -2, overage_count: 5 });
r = hud.render(hot, now);
assert.strictEqual(r.text, '$(copilot) premium ▰▰▰▰▰ 100% $(flame)');
assert.strictEqual(r.level, 'error');
assert.match(r.tooltip, /\+5 overage/);

// unlimited everywhere
const inf = structuredClone(fx);
for (const q of Object.values(inf.quota_snapshots)) q.unlimited = true;
assert.strictEqual(hud.render(inf, now).text, '$(copilot) ∞');

// cycle: Oct 16 12:00 of Oct 1 -> Nov 1 = 15.5/31 days = 50%
const cyc = hud.cycle(fx, now);
assert.strictEqual(Math.round(cyc.pct), 50);
assert.strictEqual(cyc.days, 31);

// forecast: 75% used at 50% of cycle -> projected 150%, runs out at 1/3 of the way... i.e. day 20.67
let f = hud.forecast({ included: true, used: 75 }, cyc, now);
assert.strictEqual(f.status, 'hot');
assert.strictEqual(Math.round(f.projected), 150);
assert.strictEqual(Math.round((f.runOut - cyc.start) / DAY * 100) / 100, 20.67);
assert.match(hud.forecastText(f, cyc), /Runs out ~Oct 21, 10d before reset/);
assert.strictEqual(hud.forecast({ included: true, used: 45 }, cyc, now).status, 'pace'); // 90%
assert.strictEqual(hud.forecast({ included: true, used: 20 }, cyc, now).status, 'cool'); // 40%
assert.strictEqual(hud.forecast({ included: true, used: 0 }, cyc, now).status, 'idle');

// alerts: fire once per level per cycle, reset on new cycle
const q = (used) => [{ key: 'chat', name: 'Chat', included: true, used, remaining: 1 }];
let a = hud.alerts(undefined, q(80), '2026-11-01');
assert.deepStrictEqual(a.fire.map((x) => x.level), [75]);
a = hud.alerts(a.state, q(85), '2026-11-01');
assert.strictEqual(a.fire.length, 0);
a = hud.alerts(a.state, q(95), '2026-11-01');
assert.deepStrictEqual(a.fire.map((x) => x.level), [90]);
a = hud.alerts(a.state, q(95), '2026-12-01');
assert.deepStrictEqual(a.fire.map((x) => x.level), [90]);

// history: dedupe within 30 min, drop previous cycle
let h = hud.record([{ t: cyc.start - DAY, u: {} }], q(10), now, cyc.start);
assert.strictEqual(h.length, 1);
h = hud.record(h, q(10), now + 60e3, cyc.start);
assert.strictEqual(h.length, 1);
h = hud.record(h, q(11), now + 120e3, cyc.start);
assert.strictEqual(h.length, 2);

// panel renders, escapes API strings
const evil = { ...hot, copilot_plan: '<img src=x onerror=alert(1)>' };
const html = hud.panelHtml({ data: evil, history: h, now, nonce: 'n' });
assert.ok(!html.includes('<img src=x'));
assert.match(html, /Premium requests/);
assert.match(html, /<polyline/);
console.log('ok');
