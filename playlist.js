const { assertSafeUrl, redactUrl } = require('./netGuard')
const Logger = new (require('./logger'))()

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
    assertSafeUrl(url, { allowPrivateNetwork })
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

/**
 * Turns an m3u8 body into the channel list the DVR serves.
 * Pure and synchronous so it can be exercised without a network or a server.
 */
function parsePlaylist (m3u8, settings) {
  const config = settings || {}
  const allowPrivateNetwork = Boolean(config.allowPrivateNetwork)
  const filters = Array.isArray(config.filter) ? config.filter : []
  const channels = []
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
    let channel = defaultChannel
    let found = false

    for (const filter of filters) {
      let nameFilter = filter && filter.name !== undefined ? filter.name : false
      let metaFilter = filter && filter.meta !== undefined ? filter.meta : false
      if (!nameFilter || !metaFilter) {
        if (nameFilter !== false) {
          nameFilter = matchesPattern(name, nameFilter)
        } else {
          nameFilter = true
        }
        if (metaFilter !== false) {
          metaFilter = matchesPattern(meta, metaFilter)
        } else {
          metaFilter = true
        }
        if (nameFilter && metaFilter) {
          name = filter.rename !== undefined ? filter.rename : name
          channel = filter.channel
          found = true
          break
        }
      }
    }

    if (!found && !config.removeIfNotFoundOnFilter) {
      defaultChannel++
    }
    if (found || (!found && !config.removeIfNotFoundOnFilter)) {
      channels.push({ channel: `${channel}`, name, url })
    }
  }

  const ordered = channels.sort((a, b) => Number(a.channel) - Number(b.channel))
  if (Number(config.limit) > 0) {
    return ordered.slice(0, Number(config.limit))
  }
  return ordered
}

module.exports = {
  DEFAULT_CHANNEL,
  isStreamableUrl,
  parsePlaylist,
  redactUrl
}
