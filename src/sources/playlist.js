const { assertStreamUrl, redactUrl } = require('../net/netGuard')
const Logger = new (require('../logger'))()

const PARSING_RULE = /#EXTINF:(.*),(.*)[\r\n]+(.*)/gm
const DEFAULT_CHANNEL = 80000

/**
 * A playlist entry only becomes a channel if its URL is one the proxy is
 * willing to fetch. The previous check (`valid-url`'s isUri) accepted any
 * scheme at all, so a hostile or tampered playlist could put `file://`,
 * `gopher://` or an intranet address into the lineup and have the server
 * dereference it on behalf of anyone who could reach the proxy.
 */
function isStreamableUrl (url, allowPrivateNetwork) {
  try {
    assertStreamUrl(url, { allowPrivateNetwork })
    return true
  } catch (error) {
    Logger.warn(`Skipping channel with an unusable URL: ${error.message}`)
    return false
  }
}

function matchesPattern (value, pattern) {
  try {
    return value.search(pattern) !== -1
  } catch (error) {
    // An invalid regular expression in the settings used to abort startup.
    Logger.warn(`Ignoring invalid filter pattern ${JSON.stringify(pattern)}: ${error.message}`)
    return false
  }
}

// Characters that mean something to a regular expression. A filter full of
// them that matched nothing is almost always someone typing a channel name
// literally, which is the single most common confusion in the tracker.
const REGEX_METACHARACTERS = /[+*?()[\]{}|^$\\]/

function escapeHint (pattern) {
  if (typeof pattern !== 'string' || !REGEX_METACHARACTERS.test(pattern)) return ''
  const escaped = pattern.replace(/[+*?()[\]{}|^$.\\]/g, '\\$&')
  return ` Patterns are regular expressions, so if you meant that literally, write it as ${JSON.stringify(escaped)}.`
}

/**
 * Pulls the key="value" attributes out of an #EXTINF line: tvg-logo, tvg-id
 * and friends. Providers vary on spacing, so `tvg-logo = "x"` parses too.
 */
function parseAttributes (meta) {
  const attributes = {}
  if (typeof meta !== 'string') return attributes
  const rule = /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g
  let found
  while ((found = rule.exec(meta)) !== null) {
    attributes[found[1].toLowerCase()] = found[2]
  }
  return attributes
}

/**
 * A logo URL comes out of the playlist, which is not trusted, and is handed
 * straight to Plex to load. Only plain http(s) links are passed on, so a
 * playlist cannot smuggle a javascript: or data: URL into the guide.
 */
function usableLogo (url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.toString()
  } catch (error) {
    return ''
  }
}

/**
 * Turns an m3u8 body into the channel list the DVR serves.
 * Pure and synchronous so it can be exercised without a network or a server.
 */
function parsePlaylist (m3u8, settings) {
  const config = settings || {}
  const allowPrivateNetwork = Boolean(config.allowPrivateNetwork)
  const filters = Array.isArray(config.filter) ? config.filter : []
  const channels = []
  // How many channels each filter has already claimed, so a filter matching
  // more than one channel can number them consecutively instead of giving them
  // all the same number.
  const filterUsage = new Map()
  let defaultChannel = DEFAULT_CHANNEL
  let match

  const rule = new RegExp(PARSING_RULE.source, PARSING_RULE.flags)
  while ((match = rule.exec(m3u8)) !== null) {
    if (match.index === rule.lastIndex) {
      rule.lastIndex++
    }
    if (match.length !== 4 || !isStreamableUrl(match[3], allowPrivateNetwork)) {
      continue
    }

    const meta = match[1]
    let name = match[2]
    const url = match[3]
    let channel = null
    let found = false

    for (let index = 0; index < filters.length; index++) {
      const filter = filters[index]
      if (!filter) continue
      const namePattern = filter.name !== undefined ? filter.name : false
      const metaPattern = filter.meta !== undefined ? filter.meta : false

      // A filter with neither pattern matches every channel, which collapses
      // the whole lineup onto one number. That is never what anyone means.
      if (namePattern === false && metaPattern === false) {
        if (!filterUsage.has(`warned:${index}`)) {
          filterUsage.set(`warned:${index}`, true)
          Logger.warn(`Ignoring filter #${index + 1}: it sets neither "name" nor "meta", so it would match every channel.`)
        }
        continue
      }

      // Both patterns have to match when both are given. The previous
      // implementation guarded this whole block with `if (!name || !meta)`,
      // so a filter specifying both - the combined form the README documents -
      // could never match anything.
      if (namePattern !== false && !matchesPattern(name, namePattern)) continue
      if (metaPattern !== false && !matchesPattern(meta, metaPattern)) continue

      name = filter.rename !== undefined ? filter.rename : name
      const base = Number(filter.channel)
      if (Number.isFinite(base)) {
        // Consecutive numbering from the filter's channel. Every match used to
        // be given the identical number, and Plex keeps only one channel per
        // number, so a filter like "UK" collapsed to a single entry.
        const used = filterUsage.get(index) || 0
        channel = base + used
        filterUsage.set(index, used + 1)
      }
      // else: the filter matched but named no channel, so it falls through to
      // auto-numbering below instead of becoming the string "undefined".
      found = true
      break
    }

    if (!found && config.removeIfNotFoundOnFilter) {
      continue
    }
    if (channel === null) {
      channel = defaultChannel
      defaultChannel++
    }
    const attributes = parseAttributes(meta)
    channels.push({
      channel: `${channel}`,
      name,
      url,
      // Carried through for the guide. Absent attributes stay empty rather
      // than undefined, so nothing downstream has to guard for it.
      logo: usableLogo(attributes['tvg-logo']),
      tvgId: attributes['tvg-id'] || ''
    })
  }

  // A filter that matches nothing is nearly always a mistake, and silently
  // doing nothing is how it goes unnoticed for years.
  for (let index = 0; index < filters.length; index++) {
    const filter = filters[index]
    if (!filter) continue
    if (filterUsage.get(index)) continue
    if (filter.name === undefined && filter.meta === undefined) continue
    const pattern = filter.name !== undefined ? filter.name : filter.meta
    const field = filter.name !== undefined ? 'name' : 'meta'
    Logger.warn(`Filter #${index + 1} (${field} ${JSON.stringify(pattern)}) matched no channels.${escapeHint(pattern)}`)
  }

  const ordered = channels.sort((a, b) => Number(a.channel) - Number(b.channel))
  if (Number(config.limit) > 0) {
    return ordered.slice(0, Number(config.limit))
  }
  return ordered
}

module.exports = {
  DEFAULT_CHANNEL,
  escapeHint,
  parseAttributes,
  usableLogo,
  isStreamableUrl,
  parsePlaylist,
  redactUrl
}
