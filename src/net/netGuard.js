const dns = require('dns')
const net = require('net')

const ALLOWED_PROTOCOLS = ['http:', 'https:']
// Protocols a channel may use. RTSP is not fetched by this process: it is
// handed to ffmpeg, which speaks it natively. It is still validated here so a
// playlist cannot point the tuner at an internal address.
const STREAM_PROTOCOLS = ['http:', 'https:', 'rtsp:', 'rtsps:']

/**
 * Parses an IPv4 literal into its 32-bit unsigned integer representation.
 * Returns null when the input is not a dotted-quad IPv4 literal.
 */
function ipv4ToInt (address) {
  if (net.isIPv4(address) !== true) return null
  const parts = address.split('.')
  return ((Number(parts[0]) << 24) >>> 0) +
    ((Number(parts[1]) << 16) >>> 0) +
    ((Number(parts[2]) << 8) >>> 0) +
    Number(parts[3])
}

// Ranges that must never be reachable through a user supplied playlist URL.
// Blocking them is what stops the proxy from being turned into an SSRF probe
// against whatever network the server happens to sit on.
const BLOCKED_V4_RANGES = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // RFC6598 carrier grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link local, incl. cloud metadata at 169.254.169.254
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved, incl. 255.255.255.255
]

function isPrivateIPv4 (address) {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return (value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0
  })
}

/**
 * Expands an IPv6 literal into its eight 16 bit groups, resolving "::" and any
 * trailing dotted-quad. Returns null when the input is not a valid IPv6
 * address.
 */
function expandIPv6 (address) {
  let text = address.toLowerCase().split('%')[0]
  if (text.indexOf(':') === -1) return null

  // A trailing IPv4 part (::ffff:127.0.0.1) becomes two hex groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const value = ipv4ToInt(dotted[2])
    if (value === null) return null
    text = dotted[1] + ((value >>> 16) & 0xffff).toString(16) + ':' + (value & 0xffff).toString(16)
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const toGroups = (part) => (part.length === 0 ? [] : part.split(':').map((group) => parseInt(group, 16)))

  let groups
  if (halves.length === 2) {
    const head = toGroups(halves[0])
    const tail = toGroups(halves[1])
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    groups = head.concat(new Array(missing).fill(0), tail)
  } else {
    groups = toGroups(halves[0])
  }

  if (groups.length !== 8) return null
  if (groups.some((group) => Number.isNaN(group) || group < 0 || group > 0xffff)) return null
  return groups
}

function isPrivateIPv6 (address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (net.isIPv6(normalized) !== true) return false
  const groups = expandIPv6(normalized)
  if (groups === null) return false

  // IPv4 mapped (::ffff:0:0/96) and IPv4 compatible (::/96) addresses are
  // judged on the embedded IPv4 address. WHATWG URL parsing rewrites
  // ::ffff:127.0.0.1 as ::ffff:7f00:1, so matching on the dotted form alone
  // would let loopback through.
  const leadingZero = groups.slice(0, 5).every((group) => group === 0)
  if (leadingZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`
    if (groups[5] === 0 && groups[6] === 0 && groups[7] <= 1) return true // :: and ::1
    return isPrivateIPv4(embedded)
  }

  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True when the address belongs to a range that never points at a legitimate
 * public IPTV source: loopback, private, link local, multicast or reserved.
 */
function isPrivateAddress (address) {
  if (typeof address !== 'string') return false
  return isPrivateIPv4(address) || isPrivateIPv6(address)
}

/**
 * Validates a URL before it is ever handed to the HTTP client.
 * Throws for anything that is not a plain http(s) URL, and - unless private
 * network access has been explicitly enabled in the settings - for anything
 * that resolves to a literal private address.
 */
function assertSafeUrl (rawUrl, options) {
  const allowPrivateNetwork = Boolean(options && options.allowPrivateNetwork)
  const protocols = (options && options.protocols) || ALLOWED_PROTOCOLS
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new Error('Refusing to fetch an empty URL')
  }

  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new Error(`Refusing to fetch a malformed URL: ${redactUrl(rawUrl)}`)
  }

  if (protocols.indexOf(parsed.protocol) === -1) {
    const allowed = protocols.map((entry) => entry.replace(':', '')).join(', ')
    throw new Error(`Refusing to fetch unsupported protocol "${parsed.protocol}" - only ${allowed} are allowed`)
  }

  if (!allowPrivateNetwork) {
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
    if (isPrivateAddress(hostname)) {
      throw new Error(`Refusing to fetch a private network address: ${hostname}`)
    }
  }

  return parsed
}

/**
 * A drop in replacement for dns.lookup that refuses to resolve a hostname to a
 * private address. Passed to http.request so the check happens at connect
 * time, which also covers hostnames that only resolve inward (DNS rebinding).
 */
function guardedLookup (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error)
    if (Array.isArray(address)) {
      const safe = address.filter((entry) => !isPrivateAddress(entry.address))
      if (safe.length === 0) {
        return callback(new Error(`Refusing to connect: ${hostname} resolves to a private network address`))
      }
      return callback(null, safe, family)
    }
    if (isPrivateAddress(address)) {
      return callback(new Error(`Refusing to connect: ${hostname} resolves to a private network address (${address})`))
    }
    callback(null, address, family)
  })
}

// Matches the Xtream Codes stream layout, where the two segments before a
// numeric stream id are the subscriber's username and password:
//   /<user>/<pass>/12345.ts        /live/<user>/<pass>/12345.m3u8
// The numeric id keeps this from firing on ordinary CDN paths.
const XTREAM_CREDENTIAL_PATH = /^\/(?:(live|movie|series)\/)?([^/]+)\/([^/]+)\/(\d+)(\.[A-Za-z0-9]+)?$/

/**
 * Pulls every credential-looking value out of a provider URL so the logger can
 * scrub it from any message, whatever shape that message takes.
 */
function extractCredentials (rawUrl) {
  const found = []
  try {
    const parsed = new URL(rawUrl)
    if (parsed.username) found.push(decodeURIComponent(parsed.username))
    if (parsed.password) found.push(decodeURIComponent(parsed.password))
    for (const key of ['username', 'password', 'user', 'pass', 'token']) {
      const value = parsed.searchParams.get(key)
      if (value) found.push(value)
    }
    const xtream = parsed.pathname.match(XTREAM_CREDENTIAL_PATH)
    if (xtream) found.push(decodeURIComponent(xtream[2]), decodeURIComponent(xtream[3]))
  } catch (error) {
    return []
  }
  // Very short values would scrub harmless text out of unrelated log lines.
  return found.filter((value) => typeof value === 'string' && value.length >= 4)
}

/**
 * Removes credentials and the query string from a URL so it can be written to
 * the log file. IPTV playlist URLs routinely carry username/password, and the
 * log file is neither access controlled nor rotated out quickly.
 */
function redactUrl (rawUrl) {
  if (typeof rawUrl !== 'string') return String(rawUrl)
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    // Not parseable: strip anything that looks like a query string or userinfo
    // rather than risking leaking it verbatim.
    return rawUrl.replace(/\/\/[^/@\s]*@/, '//***:***@').replace(/\?.*$/, '?<redacted>')
  }
  if (parsed.username || parsed.password) {
    parsed.username = '***'
    parsed.password = '***'
  }
  // Xtream Codes panels put the credentials in the PATH, not the query:
  // http://host/<username>/<password>/<stream_id>.ts. Stripping only the
  // query string would leave the password sitting in the log in clear text.
  const xtream = parsed.pathname.match(XTREAM_CREDENTIAL_PATH)
  if (xtream) {
    const prefix = xtream[1] ? `/${xtream[1]}` : ''
    parsed.pathname = `${prefix}/***/***/${xtream[4]}${xtream[5] || ''}`
  }

  const hadQuery = parsed.search.length > 0
  parsed.search = ''
  // Appended after serialising: assigning the marker to `search` would leave
  // it percent-encoded and unreadable in the log.
  return `${parsed.toString()}${hadQuery ? '?<redacted>' : ''}`
}

// A URL sitting inside a longer sentence: from the scheme up to the first
// whitespace or quote.
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi
// Punctuation that ends the sentence rather than the URL.
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/

/**
 * Redacts every URL embedded in a free text message.
 *
 * ffmpeg writes its diagnostics to stderr with the input URL quoted back
 * verbatim, and those lines are forwarded to the log. The logger only scrubs
 * credentials it was told about at startup, so a channel URL whose credentials
 * came from a playlist rather than from settings would otherwise be written out
 * in clear text.
 */
function redactUrlsInText (text) {
  if (typeof text !== 'string') return String(text)
  return text.replace(URL_IN_TEXT, (match) => {
    const trailing = match.match(TRAILING_PUNCTUATION)
    if (!trailing) return redactUrl(match)
    return redactUrl(match.slice(0, match.length - trailing[0].length)) + trailing[0]
  })
}

/**
 * Validates a channel URL, which may be RTSP as well as HTTP.
 */
function assertStreamUrl (rawUrl, options) {
  return assertSafeUrl(rawUrl, Object.assign({}, options, { protocols: STREAM_PROTOCOLS }))
}

function isRtsp (rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol
    return protocol === 'rtsp:' || protocol === 'rtsps:'
  } catch (error) {
    return false
  }
}

module.exports = {
  ALLOWED_PROTOCOLS,
  STREAM_PROTOCOLS,
  assertStreamUrl,
  isRtsp,
  XTREAM_CREDENTIAL_PATH,
  assertSafeUrl,
  extractCredentials,
  guardedLookup,
  isPrivateAddress,
  redactUrl,
  redactUrlsInText
}
