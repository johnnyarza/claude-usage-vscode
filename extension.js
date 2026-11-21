'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TICK_MS = 30 * 1000; // local logs are rescanned on every tick
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const KIND_LABELS = {
  session: 'Current session (5-hour)',
  weekly_all: 'Weekly · all models',
  weekly_opus: 'Weekly · Opus',
  weekly_sonnet: 'Weekly · Sonnet',
};

let statusItem;
let panel;
let timer;
let log;

const state = {
  plan: null,          // normalized plan usage
  planError: null,     // string
  planFetchedAt: 0,
  subscription: null,  // e.g. "pro", "max"
  local: null,         // aggregated local token stats
  busy: false,
};

// path -> { mtimeMs, size, entries }
const fileCache = new Map();

// ---------------------------------------------------------------- helpers

function cfg() {
  return vscode.workspace.getConfiguration('claudeUsage');
}

function claudeDir() {
  const custom = (cfg().get('claudeDir') || '').trim();
  if (custom) return custom.replace(/^~(?=$|[\\/])/, os.homedir());
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function humanize(s) {
  return String(s || '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

function relTime(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'now';
  const m = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${mm}m`;
  return `${mm}m`;
}

function absTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(undefined, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function mdEsc(s) {
  return String(s == null ? '' : s).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

function level(pct) {
  if (pct == null) return 'normal';
  if (pct >= cfg().get('criticalThreshold', 90)) return 'critical';
  if (pct >= cfg().get('warningThreshold', 75)) return 'warning';
  return 'normal';
}

// ------------------------------------------------------------ plan usage

async function readCredentials() {
  const file = path.join(claudeDir(), '.credentials.json');
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error(`No Claude Code login found at ${file}. Sign in with Claude Code first.`);
  }
  const oauth = JSON.parse(raw).claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('Claude Code credentials contain no OAuth login.');
  return oauth;
}

function httpGetJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Usage endpoint returned invalid JSON.')); }
        } else {
          const e = new Error(`Usage endpoint returned HTTP ${res.statusCode}.`);
          e.status = res.statusCode;
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Usage request timed out.')));
    req.on('error', reject);
  });
}

async function fetchPlan() {
  const cred = await readCredentials();
  state.subscription = cred.subscriptionType || null;
  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    throw new Error('Your Claude Code login token has expired. Run Claude Code once to refresh it.');
  }
  try {
    const raw = await httpGetJson(USAGE_URL, {
      'Authorization': `Bearer ${cred.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-usage-vscode/0.1.0',
    });
    return normalizePlan(raw);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new Error(`Login rejected (HTTP ${e.status}). Run Claude Code once to refresh your login.`);
    }
    if (e.status === 429) throw new Error('Usage endpoint is rate limiting; will retry later.');
    throw e;
  }
}

function normalizePlan(p) {
  const limits = [];
  if (Array.isArray(p.limits) && p.limits.length) {
    for (const l of p.limits) {
      limits.push({
        kind: l.kind,
        group: l.group,
        label: KIND_LABELS[l.kind] || humanize(l.kind),
        percent: num(l.percent),
        resetsAt: l.resets_at,
      });
    }
  } else {
    const legacy = [
      ['five_hour', 'session', 'session'],
      ['seven_day', 'weekly_all', 'weekly'],
      ['seven_day_opus', 'weekly_opus', 'weekly'],
      ['seven_day_sonnet', 'weekly_sonnet', 'weekly'],
    ];
    for (const [key, kind, group] of legacy) {
      if (p[key]) {
        limits.push({ kind, group, label: KIND_LABELS[kind], percent: num(p[key].utilization), resetsAt: p[key].resets_at });
      }
    }
  }

  const breakdown = p.seven_day_breakdown && Array.isArray(p.seven_day_breakdown.rows)
    ? p.seven_day_breakdown.rows.filter(r => r && (r.percent || r.percent_of_limit))
    : [];

  let spend = null;
  if (p.spend && p.spend.enabled && p.spend.used) {
    const money = m => m ? m.amount_minor / Math.pow(10, m.exponent || 0) : null;
    spend = {
      used: money(p.spend.used),
      limit: money(p.spend.limit),
      currency: p.spend.used.currency || 'USD',
      percent: num(p.spend.percent),
    };
  }

  return { limits, breakdown, spend };
}

function sessionLimit(plan) {
  return plan && plan.limits.find(l => l.kind === 'session' || l.group === 'session');
}

function weeklyLimit(plan) {
  return plan && (plan.limits.find(l => l.kind === 'weekly_all') || plan.limits.find(l => l.group === 'weekly'));
}

// ------------------------------------------------------- local token logs

async function listJsonl(dir, out) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

async function parseLogFile(file) {
  const text = await fsp.readFile(file, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.message;
    if (!m || !m.usage || m.role !== 'assistant' || m.model === '<synthetic>') continue;
    const t = Date.parse(o.timestamp);
    if (!t) continue;
    const u = m.usage;
    entries.push({
      key: m.id ? `${m.id}:${o.requestId || ''}` : (o.uuid || `${file}:${t}`),
      t,
      model: m.model || 'unknown',
      project: o.cwd || null,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheW: u.cache_creation_input_tokens || 0,
      cacheR: u.cache_read_input_tokens || 0,
    });
  }
  return entries;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheW: 0, cacheR: 0, total: 0, messages: 0 };
}

function addTo(tot, e) {
  tot.input += e.input;
  tot.output += e.output;
  tot.cacheW += e.cacheW;
  tot.cacheR += e.cacheR;
  tot.total += e.input + e.output + e.cacheW + e.cacheR;
  tot.messages += 1;
}

async function scanLocal() {
  const now = Date.now();
  const cutoff = now - 7 * DAY;
  const files = [];
  await listJsonl(path.join(claudeDir(), 'projects'), files);

  const seen = new Set();
  for (const f of files) {
    seen.add(f);
    let st;
    try { st = await fsp.stat(f); } catch { continue; }
    if (st.mtimeMs < cutoff) { fileCache.delete(f); continue; }
    const c = fileCache.get(f);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue;
    try {
      fileCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, entries: await parseLogFile(f) });
    } catch (e) {
      log.appendLine(`Could not read ${f}: ${e.message}`);
    }
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);

  // Streaming writes one line per content block with the same message id;
  // keep the record with the largest output count per message.
  const byKey = new Map();
  for (const [file, c] of fileCache) {
    for (const e of c.entries) {
      if (e.t < cutoff) continue;
      if (!e.project) e.project = path.basename(path.dirname(file));
      const prev = byKey.get(e.key);
      if (!prev || e.output > prev.output) byKey.set(e.key, e);
    }
  }

  // Session window: use the real window from the plan if known, else last 5h.
  const sess = sessionLimit(state.plan);
  const sessReset = sess && Date.parse(sess.resetsAt);
  const sessionStart = sessReset && sessReset > now ? sessReset - 5 * HOUR : now - 5 * HOUR;

  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.getTime();

  const out = {
    sessionStart,
    sessionFromPlan: !!(sessReset && sessReset > now),
    session: emptyTotals(),
    today: emptyTotals(),
    week: emptyTotals(),
    days: [],
    models: new Map(),
    projects: new Map(),
  };
  for (let i = 6; i >= 0; i--) {
    const start = new Date(todayStart); start.setDate(start.getDate() - i);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    out.days.push({ start: start.getTime(), end: end.getTime(), tot: emptyTotals() });
  }

  for (const e of byKey.values()) {
    addTo(out.week, e);
    if (e.t >= sessionStart) addTo(out.session, e);
    if (e.t >= todayStart) addTo(out.today, e);
    const d = out.days.find(x => e.t >= x.start && e.t < x.end);
    if (d) addTo(d.tot, e);
    if (!out.models.has(e.model)) out.models.set(e.model, emptyTotals());
    addTo(out.models.get(e.model), e);
    if (!out.projects.has(e.project)) out.projects.set(e.project, emptyTotals());
    addTo(out.projects.get(e.project), e);
  }
  return out;
}

// ---------------------------------------------------------------- refresh

async function refresh(force) {
  if (state.busy) return;
  state.busy = true;
  try {
    const interval = Math.max(60, cfg().get('refreshIntervalSeconds', 120)) * 1000;
    if (!cfg().get('fetchPlanUsage', true)) {
      state.plan = null;
      state.planError = null;
    } else if (force || Date.now() - state.planFetchedAt >= interval) {
      state.planFetchedAt = Date.now();
      try {
        state.plan = await fetchPlan();
        state.planError = null;
      } catch (e) {
        state.planError = e.message || String(e);
        log.appendLine(`[${new Date().toISOString()}] plan usage: ${state.planError}`);
      }
    }
    try {
      state.local = await scanLocal();
    } catch (e) {
      log.appendLine(`[${new Date().toISOString()}] local scan: ${e.message}`);
    }
  } finally {
    state.busy = false;
  }
  updateStatusBar();
  updatePanel();
}

// ------------------------------------------------------------- status bar

function updateStatusBar() {
  const sess = sessionLimit(state.plan);
  const week = weeklyLimit(state.plan);
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.appendMarkdown(`**Claude usage**${state.subscription ? ` · ${humanize(state.subscription)} plan` : ''}\n\n`);

  let worst = null;
  if (state.plan && state.plan.limits.length) {
    const parts = [];
    if (sess && sess.percent != null) parts.push(`5h ${Math.round(sess.percent)}%`);
    if (week && week.percent != null) parts.push(`wk ${Math.round(week.percent)}%`);
    statusItem.text = `$(dashboard) ${parts.join(' · ') || 'Claude'}`;
    for (const l of state.plan.limits) {
      if (l.percent == null) continue;
      worst = worst == null ? l.percent : Math.max(worst, l.percent);
      md.appendMarkdown(`- ${mdEsc(l.label)}: **${Math.round(l.percent)}%**`);
      if (l.resetsAt) md.appendMarkdown(` · resets in ${relTime(l.resetsAt)} (${mdEsc(absTime(l.resetsAt))})`);
      md.appendMarkdown('\n');
    }
    if (state.planError) md.appendMarkdown(`\n$(warning) Last refresh failed: ${mdEsc(state.planError)}\n`);
  } else if (state.local) {
    statusItem.text = `$(dashboard) ${fmtTokens(state.local.session.total)} tok`;
    if (state.planError) md.appendMarkdown(`$(warning) Plan limits unavailable: ${mdEsc(state.planError)}\n\n`);
  } else {
    statusItem.text = '$(dashboard) Claude';
  }

  if (state.local) {
    const s = state.local.session;
    md.appendMarkdown(`\nClaude Code on this computer, ${state.local.sessionFromPlan ? 'this session window' : 'last 5 hours'}: `
      + `**${fmtTokens(s.total)}** tokens, ${s.messages} responses\n`);
  }
  md.appendMarkdown('\n_Click for details_');
  statusItem.tooltip = md;

  const lv = level(worst);
  statusItem.backgroundColor = lv === 'critical'
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : lv === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
}

// ------------------------------------------------------------------ panel

function showPanel() {
  if (panel) {
    panel.reveal();
    return;
  }
  panel = vscode.window.createWebviewPanel('claudeUsage', 'Claude Usage', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: false,
  });
  panel.onDidDispose(() => { panel = undefined; });
  panel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.type === 'refresh') refresh(true);
    if (msg && msg.type === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'claudeUsage');
  });
  updatePanel();
}

function updatePanel() {
  if (panel) panel.webview.html = renderHtml();
}

function bar(pct) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="bar"><div class="fill ${level(pct)}" style="width:${p}%"></div></div>`;
}

function totalsRow(label, t) {
  return `<tr><td>${esc(label)}</td><td class="n">${t.messages}</td><td class="n">${fmtTokens(t.input + t.cacheW)}</td>`
    + `<td class="n">${fmtTokens(t.cacheR)}</td><td class="n">${fmtTokens(t.output)}</td><td class="n strong">${fmtTokens(t.total)}</td></tr>`;
}

function tokenTable(title, rows) {
  if (!rows.length) return '';
  return `<h3>${esc(title)}</h3><table><thead><tr><th></th><th class="n">Responses</th><th class="n">Input + cache write</th>`
    + `<th class="n">Cache read</th><th class="n">Output</th><th class="n">Total</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderHtml() {
  const nonce = crypto.randomBytes(16).toString('hex');
  const parts = [];

  // Plan limits
  parts.push('<section><h2>Plan limits</h2>');
  if (!cfg().get('fetchPlanUsage', true)) {
    parts.push('<p class="muted">Plan limit fetching is turned off in settings.</p>');
  } else if (state.plan && state.plan.limits.length) {
    if (state.planError) parts.push(`<p class="warn">Last refresh failed: ${esc(state.planError)} Showing the previous values.</p>`);
    for (const l of state.plan.limits) {
      const reset = l.resetsAt ? `Resets in ${esc(relTime(l.resetsAt))} · ${esc(absTime(l.resetsAt))}` : '';
      parts.push(`<div class="limit"><div class="row"><span>${esc(l.label)}</span>`
        + `<span class="pct">${l.percent == null ? '–' : Math.round(l.percent) + '%'}</span></div>`
        + `${bar(l.percent)}<div class="muted small">${reset}</div></div>`);
    }
    if (state.plan.spend) {
      const s = state.plan.spend;
      const f = v => v == null ? '–' : v.toLocaleString(undefined, { style: 'currency', currency: s.currency });
      parts.push(`<div class="limit"><div class="row"><span>Extra usage credits</span><span class="pct">${f(s.used)}${s.limit != null ? ' / ' + f(s.limit) : ''}</span></div>`
        + (s.percent != null ? bar(s.percent) : '') + '</div>');
    }
    if (state.plan.breakdown.length) {
      parts.push('<h3>This week by product</h3><table><thead><tr><th></th><th class="n">Share of your usage</th><th class="n">Of weekly limit</th></tr></thead><tbody>');
      for (const r of state.plan.breakdown) {
        parts.push(`<tr><td>${esc(r.display_name || humanize(r.key))}</td><td class="n">${num(r.percent) ?? '–'}%</td><td class="n">${num(r.percent_of_limit) ?? '–'}%</td></tr>`);
      }
      parts.push('</tbody></table>');
    }
  } else if (state.planError) {
    parts.push(`<p class="warn">${esc(state.planError)}</p>`);
  } else {
    parts.push('<p class="muted">Loading…</p>');
  }
  parts.push('</section>');

  // Local token usage
  const L = state.local;
  parts.push('<section><h2>Claude Code tokens on this computer</h2>');
  if (!L) {
    parts.push('<p class="muted">Loading…</p>');
  } else {
    const tile = (label, t) => `<div class="tile"><div class="muted small">${esc(label)}</div>`
      + `<div class="big">${fmtTokens(t.total)}</div><div class="muted small">${t.messages} responses · ${fmtTokens(t.output)} output</div></div>`;
    parts.push('<div class="tiles">'
      + tile(L.sessionFromPlan ? 'This session window' : 'Last 5 hours', L.session)
      + tile('Today', L.today)
      + tile('Last 7 days', L.week)
      + '</div>');

    const max = Math.max(1, ...L.days.map(d => d.tot.total));
    parts.push('<h3>Daily</h3><div class="chart">');
    for (const d of L.days) {
      const h = Math.round((d.tot.total / max) * 100);
      const day = new Date(d.start).toLocaleDateString(undefined, { weekday: 'short' });
      const tip = `${new Date(d.start).toLocaleDateString()}: ${fmtTokens(d.tot.total)} tokens, ${d.tot.messages} responses, ${fmtTokens(d.tot.output)} output`;
      parts.push(`<div class="col" title="${esc(tip)}"><div class="val small">${d.tot.total ? fmtTokens(d.tot.total) : ''}</div>`
        + `<div class="stick"><div class="stickfill" style="height:${h}%"></div></div><div class="small muted">${esc(day)}</div></div>`);
    }
    parts.push('</div>');

    const sortRows = m => [...m.entries()].sort((a, b) => b[1].total - a[1].total);
    parts.push(tokenTable('By model · last 7 days', sortRows(L.models).map(([k, t]) => totalsRow(k, t))));
    parts.push(tokenTable('By project · last 7 days', sortRows(L.projects).slice(0, 15).map(([k, t]) => totalsRow(path.basename(k) || k, t))));
    parts.push('<p class="muted small">Counted from Claude Code session logs on this computer. Plan limits above also include claude.ai chats, Cowork and other devices.</p>');
  }
  parts.push('</section>');

  const updated = state.planFetchedAt ? new Date(state.planFetchedAt).toLocaleTimeString() : '–';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px 24px; max-width: 860px; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 1.4em; margin: 0; font-weight: 600; }
  h2 { font-size: 1.1em; margin: 28px 0 12px; font-weight: 600; }
  h3 { font-size: .95em; margin: 20px 0 8px; font-weight: 600; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 8px; font-size: .85em; }
  .spacer { flex: 1; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 12px; border-radius: 2px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .muted { color: var(--vscode-descriptionForeground); }
  .small { font-size: .85em; }
  .warn { color: var(--vscode-editorWarning-foreground); }
  .limit { margin-bottom: 16px; }
  .row { display: flex; justify-content: space-between; margin-bottom: 4px; }
  .pct { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { height: 8px; border-radius: 4px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); overflow: hidden; margin-bottom: 4px; }
  .fill { height: 100%; border-radius: 4px; background: var(--vscode-progressBar-background); }
  .fill.warning { background: var(--vscode-editorWarning-foreground); }
  .fill.critical { background: var(--vscode-editorError-foreground); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3)); border-radius: 4px; padding: 10px 12px; }
  .big { font-size: 1.6em; font-weight: 600; margin: 2px 0; font-variant-numeric: tabular-nums; }
  .chart { display: flex; gap: 8px; align-items: flex-end; height: 140px; }
  .col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .stick { flex: 1; width: 100%; max-width: 48px; display: flex; align-items: flex-end; }
  .stickfill { width: 100%; background: var(--vscode-progressBar-background); border-radius: 3px 3px 0 0; min-height: 1px; }
  .val { height: 1.3em; }
  table { border-collapse: collapse; width: 100%; font-size: .9em; }
  th, td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.2)); text-align: left; }
  th { font-weight: 600; color: var(--vscode-descriptionForeground); }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  .strong { font-weight: 600; }
</style></head>
<body>
<header>
  <h1>Claude Usage</h1>
  ${state.subscription ? `<span class="badge">${esc(humanize(state.subscription))}</span>` : ''}
  <span class="spacer"></span>
  <span class="muted small">Plan data updated ${esc(updated)}</span>
  <button id="refresh">Refresh</button>
  <button id="settings">Settings</button>
</header>
${parts.join('\n')}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  document.getElementById('settings').addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
</script>
</body></html>`;
}

// -------------------------------------------------------------- lifecycle

function activate(context) {
  log = vscode.window.createOutputChannel('Claude Usage');
  statusItem = vscode.window.createStatusBarItem('claudeUsage.status', vscode.StatusBarAlignment.Right, 100);
  statusItem.name = 'Claude Usage';
  statusItem.command = 'claudeUsage.showDetails';
  statusItem.text = '$(dashboard) Claude';
  statusItem.show();

  context.subscriptions.push(
    log,
    statusItem,
    vscode.commands.registerCommand('claudeUsage.showDetails', showPanel),
    vscode.commands.registerCommand('claudeUsage.refresh', () => refresh(true)),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('claudeUsage')) refresh(true); }),
    vscode.window.onDidChangeWindowState(s => { if (s.focused) refresh(false); }),
    { dispose: () => clearInterval(timer) },
  );

  timer = setInterval(() => refresh(false), TICK_MS);
  refresh(true);
}

function deactivate() {
  clearInterval(timer);
}

module.exports = { activate, deactivate };
