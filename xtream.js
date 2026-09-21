const { fetchText } = require('./httpClient')
const { redactUrl } = require('./netGuard')
const Logger = new (require('./logger'))()

// The live stream catalogue of a large provider runs to tens of megabytes, so
// the default body cap is nowhere near enough for this.
const MAX_API_BYTES = 256 * 1024 * 1024
const API_TIMEOUT = 120000

/**
 * True when the settings describe an Xtream account rather than a playlist URL.
 */
function isConfigured (settings) {
  const xtream = settings && settings.xtream
  return Boolean(xtream && xtream.url && xtream.username && xtream.password)
}

function baseUrl (xtream) {
  const raw = String(xtream.url || '').trim().replace(/\/+$/, '')
  // Bare host:port is the form providers hand out, so assume http.
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
}

/**
 * Builds an Xtream API URL. Credentials go through URLSearchParams, so a
 * password containing & or = cannot break out of the query string.
 */
function apiUrl (xtream, params) {
  const url = new URL(`${baseUrl(xtream)}/player_api.php`)
  url.searchParams.set('username', xtream.username)
  url.searchParams.set('password', xtream.password)
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * The guide feed that goes with the account. Providers publish it beside the
 * API at the same credentials.
 */
function epgUrl (xtream) {
  const url = new URL(`${baseUrl(xtream)}/xmltv.php`)
  url.searchParams.set('username', xtream.username)
  url.searchParams.set('password', xtream.password)
  return url.toString()
}

/**
 * The playable URL for one stream. `ts` is a raw transport stream, which needs
 * no further work; `m3u8` is HLS, which the worker resolves.
 */
function streamUrl (xtream, streamId, output) {
  const extension = output === 'm3u8' ? 'm3u8' : 'ts'
  const user = encodeURIComponent(xtream.username)
  const pass = encodeURIComponent(xtream.password)
  const prefix = extension === 'm3u8' ? '/live' : ''
  return `${baseUrl(xtream)}${prefix}/${user}/${pass}/${streamId}.${extension}`
}

function requestOptions (options) {
  return {
    headers: { 'User-Agent': 'vlc 3.0.3' },
    allowPrivateNetwork: Boolean(options && options.allowPrivateNetwork),
    maxBytes: MAX_API_BYTES,
    timeout: API_TIMEOUT
  }
}

async function callApi (xtream, params, options) {
  const url = apiUrl(xtream, params)
  const body = await fetchText(url, requestOptions(options))
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`the provider did not return valid JSON from ${redactUrl(url)}`)
  }
}

/**
 * Checks the account and reports what the provider says about it. Worth doing
 * before anything else, because an expired or banned line otherwise shows up
 * as an empty channel list with no explanation.
 */
async function authenticate (xtream, options) {
  const payload = await callApi(xtream, {}, options)
  const info = payload && payload.user_info
  if (!info || String(info.auth) !== '1') {
    const message = (info && info.message) || 'the provider rejected these credentials'
    throw new Error(message)
  }
  if (info.status && String(info.status).toLowerCase() !== 'active') {
    throw new Error(`the account is ${info.status}`)
  }
  return info
}

/**
 * Turns the Xtream catalogue into an m3u8 body.
 *
 * Producing a playlist rather than channel objects is deliberate: everything
 * downstream, the filters, the renaming, the limit, the URL validation, is
 * already written against a playlist and stays identical whichever way the
 * channels arrived.
 */
async function buildPlaylist (xtream, options) {
  const settings = options || {}
  const info = await authenticate(xtream, settings)
  const connections = `${info.active_cons || 0}/${info.max_connections || '?'}`
  Logger.info(`Xtream account is ${info.status || 'active'}, using ${connections} connections.`)

  let categories = new Map()
  try {
    const list = await callApi(xtream, { action: 'get_live_categories' }, settings)
    if (Array.isArray(list)) {
      categories = new Map(list.map((entry) => [String(entry.category_id), entry.category_name || '']))
    }
  } catch (error) {
    // Groups are a nicety. Losing them must not lose the channels.
    Logger.warn(`Could not read categories, channels will have no group: ${error.message}`)
  }

  const streams = await callApi(xtream, { action: 'get_live_streams' }, settings)
  if (!Array.isArray(streams)) {
    throw new Error('the provider returned no live streams')
  }

  const lines = ['#EXTM3U']
  for (const stream of streams) {
    if (stream.stream_id === undefined || stream.stream_id === null) continue
    const name = stream.name || `Channel ${stream.stream_id}`
    const attributes = [
      `tvg-id="${xmlAttribute(stream.epg_channel_id || '')}"`,
      `tvg-name="${xmlAttribute(name)}"`,
      `tvg-logo="${xmlAttribute(stream.stream_icon || '')}"`,
      `group-title="${xmlAttribute(categories.get(String(stream.category_id)) || '')}"`
    ].join(' ')
    // The display name has to be flattened too, not just the attributes. A
    // newline in it would end the line early and let a provider's channel name
    // inject an entry of its own, pointing anywhere it liked.
    lines.push(`#EXTINF:-1 ${attributes},${displayName(name)}`)
    lines.push(streamUrl(xtream, stream.stream_id, settings.output || xtream.output))
  }
  lines.push('')

  Logger.info(`Xtream catalogue: ${streams.length} live streams.`)
  return lines.join('\n')
}

/**
 * Flattens a channel name onto one line. Everything in a playlist is line
 * oriented, so a name carrying a line break is the one thing that can turn a
 * single entry into two.
 */
function displayName (value) {
  return String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Attribute values are wrapped in double quotes, so a quote or a newline in a
 * provider's channel name would otherwise corrupt the line.
 */
function xmlAttribute (value) {
  return String(value == null ? '' : value).replace(/"/g, '').replace(/[\r\n]+/g, ' ')
}

/**
 * The credentials that must never appear in a log line.
 */
function secrets (xtream) {
  if (!xtream) return []
  return [xtream.username, xtream.password].filter((value) => typeof value === 'string' && value.length >= 4)
}

module.exports = {
  API_TIMEOUT,
  displayName,
  MAX_API_BYTES,
  apiUrl,
  authenticate,
  baseUrl,
  buildPlaylist,
  epgUrl,
  isConfigured,
  secrets,
  streamUrl,
  xmlAttribute
}
