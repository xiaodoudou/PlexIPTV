const fs = require('fs')
const path = require('path')
const { redactUrl } = require('../net/netGuard')
const packageJson = require('../../package.json')

const LOG_TAIL_LINES = 60
// Reading the whole log to show the last few lines would mean holding a rotated
// file in memory. Only the tail is ever needed.
const LOG_TAIL_BYTES = 128 * 1024
// The log file keeps the colour codes the console printed.
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
const LOG_LINE = /^(\S+)\s+plexiptv:([^:\s]+):(\S+)\s+\S+\s+\S+\s*(.*)$/

function readLogTail (logDir, maxLines) {
  const file = path.join(logDir || '', 'logs.txt')
  let handle
  try {
    handle = fs.openSync(file, 'r')
  } catch (error) {
    return []
  }
  try {
    const size = fs.fstatSync(handle).size
    const length = Math.min(size, LOG_TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    fs.readSync(handle, buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    // The first line is very likely cut in half by the byte window.
    if (size > length) lines.shift()
    return lines
      .filter((line) => line.trim().length > 0)
      .slice(-(maxLines || LOG_TAIL_LINES))
      .map(parseLogLine)
  } catch (error) {
    return []
  } finally {
    fs.closeSync(handle)
  }
}

function parseLogLine (raw) {
  const line = String(raw).replace(ANSI, '')
  const match = line.match(LOG_LINE)
  if (!match) return { time: '', module: '', level: 'info', message: line.trim() }
  return { time: match[1], module: match[2], level: match[3], message: match[4].trim() }
}

/**
 * What is playing right now, read straight off the live workers.
 *
 * Nothing here subscribes or mutates: the dashboard must never be able to
 * change the behaviour of a stream someone is watching.
 */
function activeStreams (preloader) {
  if (!preloader || !preloader.workers) return []
  const streams = []
  for (const worker of preloader.workers.values()) {
    const line = worker.line || {}
    streams.push({
      channel: line.channel != null ? String(line.channel) : '',
      name: line.name || '',
      viewers: worker.listeners || 0,
      transport: worker.rtsp ? 'rtsp' : (worker.hls ? 'hls' : 'direct'),
      failures: worker.failures || 0,
      upstreamStatus: worker.upstreamStatus != null ? worker.upstreamStatus : null,
      // The upstream URL carries the subscription credentials. It has no place
      // on a page, even an authenticated one.
      url: redactUrl(line.url || '')
    })
  }
  return streams.sort((a, b) => Number(a.channel) - Number(b.channel))
}

function hostOf (url) {
  try {
    return new URL(url).host
  } catch (error) {
    return redactUrl(String(url))
  }
}

/**
 * The configured sources, named but never with their credentials.
 *
 * Reads the list form first and falls back to the single source settings, so
 * this reports correctly whether or not the sources array is in use.
 */
function configuredSources (settings, status) {
  const config = settings || {}
  if (status && Array.isArray(status.sources)) return status.sources

  const sources = []
  const listed = Array.isArray(config.sources) ? config.sources : []
  for (const entry of listed) {
    if (!entry || !entry.url) continue
    const type = entry.type || (entry.username && entry.password ? 'xtream' : 'm3u')
    sources.push({ name: entry.name || hostOf(entry.url), type, state: 'configured' })
  }
  if (sources.length > 0) return sources

  const xtream = config.xtream
  if (xtream && xtream.url && xtream.username) {
    sources.push({ name: hostOf(xtream.url), type: 'xtream', state: 'configured' })
  }
  const remote = config.m3u8 && config.m3u8.remote
  if (typeof remote === 'string' && remote.trim().length > 0) {
    sources.push({ name: hostOf(remote), type: 'm3u', state: 'configured' })
  }
  return sources
}

function formatUptime (seconds) {
  const total = Math.floor(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${total % 60}s`
}

/**
 * Everything the page shows, gathered in one pass.
 */
function build (server, options) {
  const flags = (options && options.flags) || {}
  const settings = server.settings || {}
  const log = readLogTail(flags.logdir, LOG_TAIL_LINES)
  const streams = activeStreams(server.preloader)

  return {
    version: packageJson.version,
    uptime: formatUptime(process.uptime()),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.version,
    channels: Array.isArray(server.channels) ? server.channels.length : 0,
    streams,
    viewers: streams.reduce((total, stream) => total + stream.viewers, 0),
    sources: configuredSources(settings, server.sourceStatus),
    // Warnings and errors, newest first, so a 458 is visible without reading
    // the whole tail.
    problems: log.filter((entry) => entry.level === 'warn' || entry.level === 'error').slice(-15).reverse(),
    log: log.slice(-LOG_TAIL_LINES).reverse(),
    generatedAt: new Date().toISOString()
  }
}

module.exports = {
  LOG_TAIL_LINES,
  activeStreams,
  build,
  configuredSources,
  formatUptime,
  parseLogLine,
  readLogTail
}
