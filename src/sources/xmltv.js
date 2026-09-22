const { streamRequest } = require('../net/httpClient')
const { redactUrl } = require('../net/netGuard')
const Logger = new (require('../logger'))()

// The guide is a convenience, never a precondition for watching television.
// Everything here is best effort: if the provider has no EPG, or it is slow,
// or it is broken, the channel list still goes out with its logos attached.
const EPG_TIMEOUT = 60000
const EPG_MAX_BYTES = 512 * 1024 * 1024
// No single XMLTV element is legitimately larger than this.
const MAX_ELEMENT_BYTES = 4 * 1024 * 1024
const NEWLINE = String.fromCharCode(10)

function escapeXml (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Derives the Xtream guide URL from a playlist URL, since providers publish
 * both at the same place. Returns '' when the playlist is not an Xtream one.
 */
function guessEpgUrl (playlistUrl) {
  if (typeof playlistUrl !== 'string' || playlistUrl.length === 0) return ''
  try {
    const parsed = new URL(playlistUrl)
    if (!/\/get\.php$/.test(parsed.pathname)) return ''
    const username = parsed.searchParams.get('username')
    const password = parsed.searchParams.get('password')
    if (!username || !password) return ''
    const epg = new URL(parsed.toString())
    epg.pathname = parsed.pathname.replace(/get\.php$/, 'xmltv.php')
    epg.search = ''
    epg.searchParams.set('username', username)
    epg.searchParams.set('password', password)
    return epg.toString()
  } catch (error) {
    return ''
  }
}

/**
 * The <channel> half of the guide: what the tuner offers, named and numbered
 * as this server presents them, with whatever logo the playlist carried.
 */
function buildChannelElements (channels) {
  const parts = []
  for (const line of channels) {
    parts.push(`  <channel id="${escapeXml(line.channel)}">`)
    parts.push(`    <display-name>${escapeXml(line.name)}</display-name>`)
    parts.push(`    <display-name>${escapeXml(line.channel)}</display-name>`)
    if (line.logo) {
      parts.push(`    <icon src="${escapeXml(line.logo)}" />`)
    }
    parts.push('  </channel>')
  }
  return parts.join('\n')
}

/**
 * Maps the provider's own channel ids onto the numbers this server hands Plex,
 * so programme data still lands on the right channel after filtering and
 * renaming have moved everything around.
 */
function buildIdMap (channels) {
  const map = new Map()
  for (const line of channels) {
    if (line.tvgId) map.set(line.tvgId, line.channel)
  }
  return map
}

/**
 * Renumbers one <programme> onto the channel number this server uses, or
 * returns null when the lineup does not carry that channel.
 */
function remapProgramme (programme, idMap) {
  const id = (programme.match(/\schannel="([^"]*)"/) || [])[1]
  if (!id) return null
  const mapped = idMap.get(id)
  if (!mapped) return null
  return programme.replace(/(\schannel=")[^"]*(")/, `$1${escapeXml(mapped)}$2`)
}

/**
 * Pulls complete <programme> elements out of a chunk of XMLTV, returning the
 * ones found and whatever tail could not yet be completed.
 *
 * Element boundaries, not lines: real guides put newlines inside programme
 * descriptions and pack several programmes onto one line, so anything
 * line-oriented cuts straight through the middle of an element.
 */
function extractProgrammes (buffer) {
  const programmes = []
  let cursor = 0
  while (true) {
    const start = buffer.indexOf('<programme', cursor)
    if (start === -1) break
    const end = buffer.indexOf('</programme>', start)
    if (end === -1) break
    const stop = end + '</programme>'.length
    programmes.push(buffer.slice(start, stop))
    cursor = stop
  }
  // Only the tail that could still become a programme is worth keeping. A
  // provider guide carries a lot of text that is not a programme, and holding
  // it would grow the buffer for nothing.
  let rest = buffer.slice(cursor)
  const partial = rest.lastIndexOf('<programme')
  if (partial > 0) {
    rest = rest.slice(partial)
  } else if (partial === -1) {
    // Keep just enough to catch an opening tag split across two chunks.
    rest = rest.slice(-'<programme'.length)
  }
  return { programmes, rest }
}

/**
 * Streams the provider's guide and keeps only the programmes belonging to
 * channels this server actually carries, renumbered to match the lineup.
 *
 * Discarding the rest is not only tidiness: a provider guide covering every
 * channel they sell runs to tens of megabytes, of which a filtered lineup
 * needs a fraction of a percent.
 */
function pipeProgrammes (epgUrl, idMap, options, write) {
  return new Promise((resolve) => {
    const request = streamRequest(epgUrl, {
      headers: { 'User-Agent': 'vlc 3.0.3' },
      allowPrivateNetwork: Boolean(options.allowPrivateNetwork),
      timeout: EPG_TIMEOUT
    })

    let buffer = ''
    let bytes = 0
    let kept = 0
    let status = 0
    let settled = false

    const finish = (error) => {
      if (settled) return
      settled = true
      if (error) {
        Logger.warn(`Guide data unavailable from ${redactUrl(epgUrl)}: ${error.message}`)
      } else {
        Logger.verbose(`Guide: kept ${kept} programmes for the channels in this lineup.`)
      }
      resolve(!error)
    }

    const drain = () => {
      const found = extractProgrammes(buffer)
      buffer = found.rest
      for (const programme of found.programmes) {
        const remapped = remapProgramme(programme, idMap)
        if (remapped === null) continue
        kept = kept + 1
        write(remapped + NEWLINE)
      }
      // A single element should never be this large. If no closing tag has
      // turned up, the feed is not what it claims to be, so stop buffering.
      if (buffer.length > MAX_ELEMENT_BYTES) {
        buffer = buffer.slice(-MAX_ELEMENT_BYTES)
      }
    }

    request.on('response', (response) => { status = response.statusCode })
    request.on('data', (chunk) => {
      bytes = bytes + chunk.length
      if (bytes > EPG_MAX_BYTES) {
        request.abort()
        return finish(new Error(`guide exceeded ${EPG_MAX_BYTES} bytes`))
      }
      buffer = buffer + chunk.toString('utf8')
      drain()
    })
    request.on('error', (error) => finish(error))
    request.on('end', () => {
      drain()
      if (status < 200 || status >= 300) return finish(new Error(`guide returned HTTP ${status}`))
      finish(null)
    })
  })
}

module.exports = {
  EPG_MAX_BYTES,
  extractProgrammes,
  EPG_TIMEOUT,
  buildChannelElements,
  buildIdMap,
  escapeXml,
  guessEpgUrl,
  pipeProgrammes,
  remapProgramme
}
