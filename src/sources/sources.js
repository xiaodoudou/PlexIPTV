const { fetchText } = require('../net/httpClient')
const Xtream = require('./xtream')
const Logger = new (require('../logger'))()

const PLAYLIST_MAX_BYTES = 256 * 1024 * 1024
const PLAYLIST_TIMEOUT = 120000

/**
 * A readable name for a source, for the log. Never the credentials.
 */
function describe (source, index) {
  if (source.name) return source.name
  if (source.type === 'xtream') {
    try {
      return new URL(Xtream.baseUrl(source)).host
    } catch (error) {
      return `xtream source ${index + 1}`
    }
  }
  try {
    return new URL(source.url).host
  } catch (error) {
    return `playlist ${index + 1}`
  }
}

/**
 * Works out what to load, from either the list form or the single source
 * settings that came before it.
 *
 * `sources` is the current shape. The older `xtream` block and `m3u8.remote`
 * still work, and are simply read as a list of one.
 */
function describeSources (settings) {
  const config = settings || {}
  const listed = Array.isArray(config.sources) ? config.sources : []
  const sources = []

  for (const entry of listed) {
    if (!entry) continue
    const type = entry.type || (entry.username && entry.password ? 'xtream' : 'm3u')
    if (type === 'xtream') {
      if (!entry.url || !entry.username || !entry.password) continue
      sources.push(Object.assign({ type: 'xtream' }, entry))
    } else {
      if (!entry.url) continue
      sources.push(Object.assign({ type: 'm3u' }, entry))
    }
  }

  if (sources.length > 0) return sources

  // Nothing listed, so fall back to the single source settings.
  if (Xtream.isConfigured(config)) {
    sources.push(Object.assign({ type: 'xtream' }, config.xtream))
  }
  const remote = config.m3u8 && config.m3u8.remote
  if (typeof remote === 'string' && remote.trim().length > 0) {
    sources.push({ type: 'm3u', url: remote.trim() })
  }
  return sources
}

/**
 * Every credential across every source, so the logger can scrub them all.
 */
function secrets (settings) {
  const found = []
  for (const source of describeSources(settings)) {
    if (source.type === 'xtream') found.push(...Xtream.secrets(source))
  }
  return found
}

/**
 * The guide feeds belonging to the configured sources.
 */
function epgUrls (settings) {
  const config = settings || {}
  const configured = typeof config.epgUrl === 'string' ? config.epgUrl.trim() : ''
  if (configured.length > 0) return [configured]

  const urls = []
  for (const source of describeSources(config)) {
    if (source.epgUrl) {
      urls.push(source.epgUrl)
    } else if (source.type === 'xtream') {
      urls.push(Xtream.epgUrl(source))
    }
  }
  return urls
}

async function loadOne (source, options) {
  if (source.type === 'xtream') {
    return Xtream.buildPlaylist(source, options)
  }
  return fetchText(source.url, {
    allowPrivateNetwork: Boolean(options && options.allowPrivateNetwork),
    maxBytes: PLAYLIST_MAX_BYTES,
    timeout: PLAYLIST_TIMEOUT
  })
}

/**
 * Joins several playlists into one body.
 *
 * Merging the text rather than the parsed channels is deliberate: channel
 * numbering, filters, renaming and the limit all run once over the result, so
 * two sources cannot both claim channel 80000 and a filter spanning both
 * behaves as one would expect.
 */
function merge (bodies) {
  const lines = ['#EXTM3U']
  for (const body of bodies) {
    for (const line of String(body).split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      // Each source brings its own header; one is enough.
      if (trimmed.startsWith('#EXTM3U')) continue
      lines.push(line)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Loads every source and merges what came back.
 *
 * One provider being down must not cost you the others, so each is loaded
 * independently and a failure is reported and skipped. Only when nothing at all
 * loads does this reject, which lets the caller fall back to the cached copy.
 */
async function loadAll (settings, options) {
  const sources = describeSources(settings)
  if (sources.length === 0) {
    throw new Error('No playlist or Xtream account is configured. Set "sources" in your settings.')
  }

  const results = await Promise.all(sources.map(async (source, index) => {
    const name = describe(source, index)
    try {
      const body = await loadOne(source, options)
      const count = (body.match(/#EXTINF/g) || []).length
      Logger.info(`Loaded ${count} channels from ${name}.`)
      return { name, body, ok: true }
    } catch (error) {
      Logger.error(`Could not load ${name}: ${error.message}`)
      return { name, ok: false }
    }
  }))

  const loaded = results.filter((result) => result.ok)
  const failed = results.filter((result) => !result.ok).map((result) => result.name)

  if (loaded.length === 0) {
    throw new Error(`none of the ${sources.length} configured sources could be loaded`)
  }
  if (failed.length > 0) {
    Logger.warn(`Carrying on without ${failed.join(', ')}. ${loaded.length} of ${sources.length} sources loaded.`)
  }

  return {
    body: merge(loaded.map((result) => result.body)),
    loaded: loaded.map((result) => result.name),
    failed
  }
}

module.exports = {
  PLAYLIST_MAX_BYTES,
  PLAYLIST_TIMEOUT,
  describe,
  describeSources,
  epgUrls,
  loadAll,
  merge,
  secrets
}
