// Everything the page needs travels in the document. No build step, no CDN, and
// nothing the browser has to fetch from a third party to render a status page
// that is supposed to work on a trusted network with no internet at all.

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}

/**
 * Channel names come from the provider's playlist, so they are untrusted input
 * and go through this before reaching the document.
 */
function escapeHtml (value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ESCAPES[char])
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --border: #e2e5ea;
  --text: #1c2128;
  --muted: #656d76;
  --accent: #2d7ff9;
  --ok: #1a7f37;
  --warn: #9a6700;
  --error: #cf222e;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --ok: #3fb950;
    --warn: #d29922;
    --error: #f85149;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px 16px 48px;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wrap { max-width: 1000px; margin: 0 auto; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
a { color: var(--accent); }
.meta { color: var(--muted); font-size: 13px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.card .value { font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
.card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
section { margin-bottom: 24px; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 14px; }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: none; }
td.num { font-variant-numeric: tabular-nums; }
.empty { background: var(--panel); border: 1px dashed var(--border); border-radius: 8px; padding: 18px; color: var(--muted); text-align: center; }
.tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); color: var(--muted); }
.level-warn { color: var(--warn); }
.level-error { color: var(--error); }
.ok { color: var(--ok); }
.log { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px; max-height: 340px; overflow: auto; }
.log div { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
.log .t { color: var(--muted); }
form.login { max-width: 340px; margin: 12vh auto 0; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 24px; }
form.login h1 { margin-bottom: 4px; }
form.login p { color: var(--muted); font-size: 13px; margin: 0 0 18px; }
label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
input[type=password] { width: 100%; padding: 9px 11px; font-size: 15px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
button { margin-top: 14px; width: 100%; padding: 9px; font-size: 15px; font-weight: 600; border: none; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
.error-box { background: color-mix(in srgb, var(--error) 12%, transparent); border: 1px solid var(--error); color: var(--error); border-radius: 6px; padding: 9px 11px; font-size: 13px; margin-bottom: 14px; }
.logout { font-size: 13px; }
`

function layout (title, body, extraHead) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${extraHead || ''}
</head>
<body><div class="wrap">${body}</div></body>
</html>
`
}

function renderLogin (options) {
  const config = options || {}
  const error = config.error
    ? `<div class="error-box">${escapeHtml(config.error)}</div>`
    : ''
  return layout('PlexIPTV', `
<form class="login" method="post" action="${escapeHtml(config.base || '')}/login">
  <h1>PlexIPTV</h1>
  <p>Enter the dashboard password.</p>
  ${error}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form>
`)
}

function card (value, label) {
  return `<div class="card"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`
}

function renderStreams (streams) {
  if (streams.length === 0) {
    return '<div class="empty">Nothing is playing right now.</div>'
  }
  const rows = streams.map((stream) => `
    <tr>
      <td class="num">${escapeHtml(stream.channel)}</td>
      <td>${escapeHtml(stream.name)}</td>
      <td class="num">${escapeHtml(stream.viewers)}</td>
      <td><span class="tag">${escapeHtml(stream.transport)}</span></td>
      <td class="num">${stream.failures > 0 ? `<span class="level-warn">${escapeHtml(stream.failures)}</span>` : '0'}</td>
      <td class="num">${stream.upstreamStatus ? `<span class="level-error">${escapeHtml(stream.upstreamStatus)}</span>` : '<span class="ok">ok</span>'}</td>
    </tr>`).join('')
  return `<table>
    <thead><tr><th>Ch</th><th>Channel</th><th>Viewers</th><th>Transport</th><th>Failures</th><th>Upstream</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function renderSources (sources) {
  if (sources.length === 0) {
    return '<div class="empty">No source is configured.</div>'
  }
  const rows = sources.map((source) => {
    const state = source.state === 'failed'
      ? '<span class="level-error">failed</span>'
      : (source.state === 'loaded' ? '<span class="ok">loaded</span>' : escapeHtml(source.state || 'configured'))
    const count = source.channels != null ? escapeHtml(source.channels) : ''
    return `<tr><td>${escapeHtml(source.name)}</td><td><span class="tag">${escapeHtml(source.type)}</span></td><td>${state}</td><td class="num">${count}</td></tr>`
  }).join('')
  return `<table>
    <thead><tr><th>Source</th><th>Type</th><th>State</th><th>Channels</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function renderProblems (problems) {
  if (problems.length === 0) {
    return '<div class="empty">No warnings or errors in the recent log.</div>'
  }
  const rows = problems.map((entry) => `
    <tr>
      <td class="meta">${escapeHtml(entry.time)}</td>
      <td><span class="level-${escapeHtml(entry.level)}">${escapeHtml(entry.level)}</span></td>
      <td>${escapeHtml(entry.module)}</td>
      <td>${escapeHtml(entry.message)}</td>
    </tr>`).join('')
  return `<table>
    <thead><tr><th>Time</th><th>Level</th><th>Module</th><th>Message</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

function renderLog (log) {
  if (log.length === 0) return '<div class="empty">The log file is empty or not readable.</div>'
  const lines = log.map((entry) => {
    const level = entry.level === 'warn' || entry.level === 'error' ? ` class="level-${escapeHtml(entry.level)}"` : ''
    return `<div><span class="t">${escapeHtml(entry.time)}</span> <span${level}>${escapeHtml(entry.module)}</span> ${escapeHtml(entry.message)}</div>`
  }).join('')
  return `<div class="log">${lines}</div>`
}

function renderDashboard (snapshot, options) {
  const config = options || {}
  const refresh = config.refreshSeconds > 0
    ? `<meta http-equiv="refresh" content="${escapeHtml(config.refreshSeconds)}">`
    : ''
  const body = `
<header>
  <div>
    <h1>PlexIPTV</h1>
    <div class="meta">v${escapeHtml(snapshot.version)} on node ${escapeHtml(snapshot.node)}, up ${escapeHtml(snapshot.uptime)}</div>
  </div>
  <div class="meta">
    Updated ${escapeHtml(snapshot.generatedAt)}
    &middot; <a class="logout" href="${escapeHtml(config.base || '')}/logout">Sign out</a>
  </div>
</header>

<div class="cards">
  ${card(snapshot.streams.length, 'Active streams')}
  ${card(snapshot.viewers, 'Viewers')}
  ${card(snapshot.channels, 'Channels')}
  ${card(snapshot.sources.length, 'Sources')}
</div>

<section><h2>Playing now</h2>${renderStreams(snapshot.streams)}</section>
<section><h2>Sources</h2>${renderSources(snapshot.sources)}</section>
<section><h2>Recent warnings and errors</h2>${renderProblems(snapshot.problems)}</section>
<section><h2>Log</h2>${renderLog(snapshot.log)}</section>
`
  return layout('PlexIPTV', body, refresh)
}

module.exports = {
  escapeHtml,
  renderDashboard,
  renderLogin
}
