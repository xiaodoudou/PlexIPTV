const EventEmitter = require('events')
const DataStream = require('./dataStream')
const { streamRequest } = require('./httpClient')
const { redactUrl } = require('./netGuard')
const { describeUpstreamStatus, isFatalUpstreamStatus } = require('./upstreamStatus')
const { describePayload, detectPayload } = require('./payload')
const { HlsReader } = require('./hls')
const Logger = new (require('./logger'))()

// An upstream that ends or fails immediately used to be retried in a tight
// loop, which burns CPU and hammers the provider. Retries are spaced out and
// capped instead.
const RETRY_DELAY = 1000
const MAX_CONSECUTIVE_FAILURES = 5
// How long an upstream is held open after the last viewer leaves, so a
// reconnecting player rejoins the running stream instead of restarting it.
const LINGER_MS = 5000

class Worker extends EventEmitter {
  constructor (guid, line, options) {
    super()

    // Declares
    this.guid = guid
    this.line = line
    this.url = line.url
    this.options = options || {}
    this.listeners = 0
    this.failures = 0
    this.upstreamStatus = null
    this.retryDelay = this.options.retryDelay != null ? this.options.retryDelay : RETRY_DELAY
    this.maxConsecutiveFailures = this.options.maxConsecutiveFailures != null
      ? this.options.maxConsecutiveFailures
      : MAX_CONSECUTIVE_FAILURES
    this.retryTimer = null
    this.lingerTimer = null
    this.lingerMs = this.options.lingerMs != null ? this.options.lingerMs : LINGER_MS
    this.hls = null
    this.finalUrl = null
    this.stream = new DataStream()

    // Bindings
    this.end = this.end.bind(this)
    this.unsubscribe = this.unsubscribe.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.requestFactory = this.requestFactory.bind(this)
    this.scheduleRetry = this.scheduleRetry.bind(this)
    this.startHls = this.startHls.bind(this)

    // Init
    this.request = this.requestFactory()
    this.once('end', () => {
      this.stream.end()
    })
    this.stream.on('data', buffer => {
      this.emit('data', buffer)
    })
    this.stream.once('end', () => {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      if (this.lingerTimer) {
        clearTimeout(this.lingerTimer)
        this.lingerTimer = null
      }
      if (this.hls) {
        this.hls.stop()
        this.hls = null
      }
      if (this.request) this.request.abort()
    })
  }

  end () {
    Logger.verbose(`End of: ${this.line.internalUrl}`)
    this.emit('end', this.guid)
  }

  unsubscribe () {
    Logger.verbose(`Unsubscribe to: ${this.line.internalUrl}`)
    this.listeners = this.listeners - 1
    if (this.listeners > 0) return
    this.listeners = 0

    if (this.lingerMs <= 0) {
      Logger.verbose('No more subscribers.')
      this.end()
      return
    }

    // Hold the upstream open briefly instead of tearing it down the moment the
    // last viewer leaves. Players reconnect constantly - Plex probes a channel
    // before tuning it, and any seek or buffer stall drops and reopens the
    // connection. Restarting the upstream each time makes the provider replay
    // from the head of its buffer, which is what "keeps coming back 10 sec"
    // describes, and on a one-connection line it also burns the only slot.
    Logger.verbose(`No more subscribers, holding ${this.line.internalUrl} open for ${this.lingerMs}ms.`)
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null
      if (this.listeners === 0) this.end()
    }, this.lingerMs)
  }

  subscribe () {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
      Logger.verbose(`Reusing the still-open upstream for: ${this.line.internalUrl}`)
    }
    Logger.verbose(`Subscribe to: ${this.line.internalUrl}`)
    this.listeners = this.listeners + 1
  }

  scheduleRetry () {
    if (this.stream.isEnded) return
    if (this.failures >= this.maxConsecutiveFailures) {
      Logger.error(`Giving up on ${this.line.internalUrl} after ${this.failures} consecutive failures.`)
      this.end()
      return
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.stream.isEnded) return
      Logger.verbose(`Renew preloading: ${this.line.internalUrl}`)
      this.request = this.requestFactory()
    }, this.retryDelay)
    if (this.retryTimer.unref) this.retryTimer.unref()
  }

  /**
   * Switches this worker from proxying bytes to following an HLS playlist,
   * stitching its segments into the continuous stream Plex expects.
   */
  startHls (url) {
    if (this.stream.isEnded || this.hls) return
    const reader = new HlsReader(url, {
      headers: { 'User-Agent': 'vlc 3.0.3' },
      allowPrivateNetwork: Boolean(this.options.allowPrivateNetwork)
    })
    this.hls = reader
    this.failures = 0

    reader.on('data', (chunk) => {
      this.stream.write(chunk)
    })
    reader.on('error', (error) => {
      if (this.stream.isEnded) return
      this.failures = this.failures + 1
      Logger.error(`HLS error on ${this.line.internalUrl}:`, error.message)
      this.hls = null
      reader.stop()
      this.scheduleRetry()
    })
    reader.on('end', () => {
      if (this.stream.isEnded) return
      this.hls = null
      this.scheduleRetry()
    })

    reader.start()
  }

  requestFactory () {
    // The upstream URL carries the subscriber's credentials, so only the
    // redacted form is ever written to the log file.
    Logger.verbose(`Preloading: ${this.line.internalUrl} (${redactUrl(this.url)})`)
    const myRequest = streamRequest(this.url, {
      headers: {
        'User-Agent': 'vlc 3.0.3'
      },
      allowPrivateNetwork: Boolean(this.options.allowPrivateNetwork)
    })

    let contentType = ''
    let sniffed = false

    myRequest.on('response', (response, finalUrl) => {
      if (response.statusCode === 200) {
        this.failures = 0
        contentType = response.headers['content-type'] || ''
        this.finalUrl = finalUrl || this.url
        return
      }
      const explanation = describeUpstreamStatus(response.statusCode)
      Logger.warn(`Cannot play ${this.line.name}: ${explanation}`)
      // A 4xx is the provider deliberately refusing us. Retrying cannot fix
      // that, and hammering a provider that is already saying no is a good way
      // to get the account flagged, so fail fast and report it upstream.
      if (isFatalUpstreamStatus(response.statusCode)) {
        this.upstreamStatus = response.statusCode
        myRequest.abort()
        this.emit('upstream-error', response.statusCode, explanation)
        this.end()
      }
    })

    myRequest.on('data', (buffer) => {
      // A 200 does not mean the provider sent video. Sniff the first chunk so
      // an HLS manifest can be resolved, and so an error page is reported
      // instead of being forwarded to Plex as if it were a stream.
      if (!sniffed) {
        sniffed = true
        const kind = detectPayload(contentType, buffer)

        if (kind === 'hls') {
          Logger.verbose(`${this.line.name} is an HLS playlist, following its segments.`)
          myRequest.abort()
          this.startHls(this.finalUrl || this.url)
          return
        }

        if (kind === 'other') {
          const explanation = describePayload(contentType, buffer)
          Logger.warn(`Cannot play ${this.line.name}: ${explanation}`)
          myRequest.abort()
          this.emit('upstream-error', 200, explanation)
          this.end()
          return
        }
      }
      this.stream.write(buffer)
    })

    myRequest.on('error', (error) => {
      this.failures = this.failures + 1
      Logger.error(`Error occured on ${this.line.internalUrl}:`, error.message)
      this.scheduleRetry()
    })

    myRequest.on('end', () => {
      this.failures = this.failures + 1
      this.scheduleRetry()
    })

    return myRequest
  }
}

module.exports = Worker
module.exports.RETRY_DELAY = RETRY_DELAY
module.exports.MAX_CONSECUTIVE_FAILURES = MAX_CONSECUTIVE_FAILURES
module.exports.LINGER_MS = LINGER_MS
