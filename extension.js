// ponytail: copilot_internal/user is undocumented (same endpoint Copilot's own UI uses). If GitHub changes it, the HUD shows a warning instead of breaking.
const URL = 'https://api.github.com/copilot_internal/user';
const QUOTAS = [['premium_interactions', 'premium'], ['chat', 'chat'], ['completions', 'completions']];
const REFRESH_MS = 5 * 60 * 1000;

const bar = (pct, w = 10) => { const n = Math.round(pct / 100 * w); return '▰'.repeat(n) + '▱'.repeat(w - n); };
const clamp = (x) => Math.max(0, Math.min(100, x));

// cycle = month before the reset date; returns % of the billing cycle elapsed
function cyclePct(resetUtc, now = Date.now()) {
  const end = new Date(resetUtc);
  if (isNaN(end)) return null;
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - 1);
  return clamp((now - start) / (end - start) * 100);
}

// pure: API json -> { text, tooltip, level } so it can be tested without VS Code
function render(data, now = Date.now()) {
  const rows = [];
  let worst = null;
  for (const [key, label] of QUOTAS) {
    const q = data.quota_snapshots?.[key];
    if (!q) continue;
    if (q.unlimited) { rows.push(`${label.padEnd(12)}${'∞'.padStart(10)}  unlimited`); continue; }
    if (!q.has_quota || !q.entitlement) continue; // plan doesn't include it
    const used = clamp(100 - q.percent_remaining);
    rows.push(`${label.padEnd(12)}${bar(used)} ${String(Math.round(used)).padStart(3)}%  ${Math.round(q.remaining)}/${q.entitlement} left` + (q.overage_count ? `  +${q.overage_count} overage` : ''));
    if (!worst || used > worst.used) worst = { label, used };
  }
  const cyc = cyclePct(data.quota_reset_date_utc || data.quota_reset_date, now);
  if (cyc != null) rows.push(`${'cycle'.padEnd(12)}${bar(cyc)} ${String(Math.round(cyc)).padStart(3)}%  resets ${data.quota_reset_date}`);

  const text = worst ? `$(copilot) ${worst.label} ${bar(worst.used, 5)} ${Math.round(worst.used)}%` : '$(copilot) ∞';
  const level = !worst ? 'ok' : worst.used >= 80 ? 'error' : worst.used >= 60 ? 'warning' : 'ok';
  const tooltip = `**Copilot usage** — ${data.copilot_plan ?? '?'} plan\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n\nUsed % vs cycle % = pace. Click to refresh.`;
  return { text, tooltip, level };
}

let vscode, item, timer;

async function token(interactive) {
  const s = await vscode.authentication.getSession('github', ['user:email'], interactive ? { createIfNone: true } : { silent: true });
  return s?.accessToken;
}

async function refresh(interactive = false) {
  try {
    const t = await token(interactive);
    if (!t) {
      item.text = '$(github) Copilot HUD: sign in';
      item.tooltip = 'Click to sign in to GitHub';
      item.command = 'copilotHud.signIn';
      item.backgroundColor = undefined;
      return;
    }
    const res = await fetch(URL, { headers: { Authorization: `token ${t}`, 'X-GitHub-Api-Version': '2025-04-01' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = render(await res.json());
    item.text = r.text;
    item.tooltip = new vscode.MarkdownString(r.tooltip);
    item.command = 'copilotHud.refresh';
    item.backgroundColor = r.level === 'ok' ? undefined : new vscode.ThemeColor(`statusBarItem.${r.level}Background`);
  } catch (e) {
    item.text = '$(warning) Copilot: ?';
    item.tooltip = `Copilot HUD failed: ${e.message}. Click to retry.`;
    item.command = 'copilotHud.refresh';
  }
}

function activate(ctx) {
  vscode = require('vscode');
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '$(copilot) …';
  item.show();
  ctx.subscriptions.push(
    item,
    vscode.commands.registerCommand('copilotHud.refresh', () => refresh()),
    vscode.commands.registerCommand('copilotHud.signIn', () => refresh(true)),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id === 'github' && refresh()),
    { dispose: () => clearInterval(timer) },
  );
  timer = setInterval(refresh, REFRESH_MS);
  refresh();
}

module.exports = { activate, deactivate() {}, render, cyclePct };
