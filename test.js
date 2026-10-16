const assert = require('assert');
const { render, cyclePct } = require('./extension');
const fx = require('./fixture.json');
const now = Date.parse('2026-10-16T12:00:00Z');

// real fixture: premium has no quota on this plan -> hidden, not "100% used"
let r = render(fx, now);
assert.ok(!r.tooltip.includes('premium'), 'premium with entitlement 0 must be hidden');
assert.match(r.tooltip, /chat\s+▱{10}\s+0%\s+200\/200 left/);
assert.match(r.tooltip, /completions\s+▱{10}\s+0%/);
assert.match(r.tooltip, /resets 2026-11-01/);
assert.strictEqual(r.level, 'ok');

// heavy usage -> worst quota in status text + error level; overage clamps
const hot = structuredClone(fx);
Object.assign(hot.quota_snapshots.chat, { percent_remaining: 10, remaining: 20 });
Object.assign(hot.quota_snapshots.premium_interactions, { has_quota: true, entitlement: 300, remaining: -5, percent_remaining: -2, overage_count: 5 });
r = render(hot, now);
assert.strictEqual(r.text, '$(copilot) premium ▰▰▰▰▰ 100%');
assert.strictEqual(r.level, 'error');
assert.match(r.tooltip, /\+5 overage/);

// unlimited everywhere
const inf = structuredClone(fx);
for (const q of Object.values(inf.quota_snapshots)) q.unlimited = true;
assert.strictEqual(render(inf, now).text, '$(copilot) ∞');

// cycle: Oct 16 12:00 of Oct 1 -> Nov 1 = 15.5/31 days = 50%
assert.strictEqual(Math.round(cyclePct('2026-11-01T00:00:00.000Z', now)), 50);
console.log('ok');
