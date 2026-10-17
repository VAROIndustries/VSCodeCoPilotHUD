// ponytail: copilot_internal/user is undocumented (same endpoint Copilot's own UI uses). If GitHub changes it, the HUD shows a warning instead of breaking.
const vscode = require('vscode');
const crypto = require('crypto');
const hud = require('./hud');

const URL = 'https://api.github.com/copilot_internal/user';
const REFRESH_MS = 5 * 60 * 1000;

let ctx, item, timer, panel, last;

async function token(interactive) {
  const s = await vscode.authentication.getSession('github', ['user:email'], interactive ? { createIfNone: true } : { silent: true });
  return s?.accessToken;
}

function drawPanel() {
  if (!panel || !last) return;
  panel.webview.html = hud.panelHtml({ data: last, history: ctx.globalState.get('history'), nonce: crypto.randomBytes(16).toString('hex'), cspSource: panel.webview.cspSource });
}

function openPanel() {
  if (panel) { panel.reveal(); return refresh(); }
  panel = vscode.window.createWebviewPanel('copilotHud', 'Copilot Usage', vscode.ViewColumn.Active, { enableScripts: true });
  panel.webview.onDidReceiveMessage((m) => m === 'refresh' && refresh());
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.html = '<body style="padding:20px;font-family:var(--vscode-font-family)">Loading…</body>';
  return refresh();
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
    last = await res.json();
    const now = Date.now(), list = hud.quotas(last), cyc = hud.cycle(last, now);

    if (cyc) await ctx.globalState.update('history', hud.record(ctx.globalState.get('history'), list, now, cyc.start));
    const a = hud.alerts(ctx.globalState.get('alerts'), list, last.quota_reset_date);
    await ctx.globalState.update('alerts', a.state);
    for (const f of a.fire) {
      vscode.window.showWarningMessage(`Copilot ${f.name}: ${Math.round(f.used)}% used (${f.remaining} left) — crossed ${f.level}%.`, 'Open dashboard')
        .then((pick) => pick && openPanel());
    }

    const r = hud.render(last, now);
    item.text = r.text;
    item.tooltip = new vscode.MarkdownString(r.tooltip);
    item.command = 'copilotHud.open';
    item.backgroundColor = r.level === 'ok' ? undefined : new vscode.ThemeColor(`statusBarItem.${r.level}Background`);
    drawPanel();
  } catch (e) {
    item.text = '$(warning) Copilot: ?';
    item.tooltip = `Copilot HUD failed: ${e.message}. Click to retry.`;
    item.command = 'copilotHud.refresh';
  }
}

function activate(context) {
  ctx = context;
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.text = '$(copilot) …';
  item.show();
  ctx.subscriptions.push(
    item,
    vscode.commands.registerCommand('copilotHud.refresh', () => refresh()),
    vscode.commands.registerCommand('copilotHud.open', openPanel),
    vscode.commands.registerCommand('copilotHud.signIn', () => refresh(true)),
    vscode.authentication.onDidChangeSessions((e) => e.provider.id === 'github' && refresh()),
    { dispose: () => clearInterval(timer) },
  );
  timer = setInterval(refresh, REFRESH_MS);
  refresh();
}

module.exports = { activate, deactivate() {} };
