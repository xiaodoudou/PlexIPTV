const EventEmitter = require('events')
const http = require('http')
const https = require('https')
const { assertSafeUrl, guardedLookup, redactUrl } = require('./netGuard')

const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_TIMEOUT = 30000
// A playlist is text. Anything past a few MB is either a mistake or someone
// trying to exhaust the process memory, so the download is capped.
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024

/**
 * Minimal streaming HTTP(S) client.
 *
 * Replaces the abandoned `request` package, which has no fixed release for its
 * SSRF and memory disclosure advisories. Every URL - including each redirect
 * hop - is validated before a socket is opened, and DNS results are screened
 * so a public hostname cannot be pointed at an internal address.
 */
class StreamRequest extends EventEmitter {
  constructor (url, options) {
    super()

    this.options = options || {}
    this.maxRedirects = this.options.maxRedirects != null ? this.options.maxRedirects : DEFAULT_MAX_REDIRECTS
    this.timeout = this.options.timeout != null ? this.options.timeout : DEFAULT_TIMEOUT
    this.allowPrivateNetwork = Boolean(this.options.allowPrivateNetwork)
    this.aborted = false
    this.request = null

    // Deferred so a caller can attach listeners before anything is emitted.
    process.nextTick(() => {
      if (this.aborted) return
      this.send(url, this.maxRedirects)
    })
  }

  send (url, redirectsLeft) {
    if (this.aborted) return

    let parsed
    try {
      parsed = assertSafeUrl(url, { allowPrivateNetwork: this.allowPrivateNetwork })
    } catch (error) {
      return this.fail(error)
    }

    const transport = parsed.protocol === 'https:' ? https : http
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: this.options.method || 'GET',
      headers: this.options.headers || {},
      // Screens the resolved address, not just the literal in the URL.
      lookup: this.allowPrivateNetwork ? undefined : guardedLookup
    }, (response) => {
      if (this.aborted) {
        response.destroy()
        return
      }

      const status = response.statusCode
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume() // drain, we are not using this body
        if (redirectsLeft <= 0) {
          return this.fail(new Error(`Too many redirects while fetching ${redactUrl(url)}`))
        }
        let next
        try {
          next = new URL(location, url).toString()
        } catch (error) {
          return this.fail(new Error(`Refusing to follow a malformed redirect from ${redactUrl(url)}`))
        }
        return this.send(next, redirectsLeft - 1)
      }

      this.emit('response', response)
      response.on('data', (chunk) => this.emit('data', chunk))
      response.on('end', () => { if (!this.aborted) this.emit('end') })
      response.on('error', (error) => this.fail(error))
    })

    this.request = request
    request.setTimeout(this.timeout, () => {
      request.destroy(new Error(`Timed out after ${this.timeout}ms fetching ${redactUrl(url)}`))
    })
    request.on('error', (error) => {
      if (this.aborted) return
      this.fail(error)
    })
    request.end()
  }

  fail (error) {
    if (this.aborted) return
    this.emit('error', error)
  }

  abort () {
    if (this.aborted) return
    this.aborted = true
    if (this.request) this.request.destroy()
  }
}

function streamRequest (url, options) {
  return new StreamRequest(url, options)
}

/**
 * Downloads a URL into a string, refusing anything larger than maxBytes.
 */
function fetchText (url, options) {
  const settings = options || {}
  const maxBytes = settings.maxBytes != null ? settings.maxBytes : DEFAULT_MAX_BYTES
  return new Promise((resolve, reject) => {
    const request = streamRequest(url, settings)
    const chunks = []
    let size = 0
    let statusCode = 0

    request.on('response', (response) => { statusCode = response.statusCode })
    request.on('data', (chunk) => {
      size = size + chunk.length
      if (size > maxBytes) {
        request.abort()
        reject(new Error(`Response from ${redactUrl(url)} exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (statusCode < 200 || statusCode >= 300) {
        reject(new Error(`Unexpected status ${statusCode} from ${redactUrl(url)}`))
        return
      }
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  StreamRequest,
  fetchText,
  streamRequest
}
