const EventEmitter = require('events')
const DataStream = require('./dataStream')
const { streamRequest } = require('./httpClient')
const { redactUrl } = require('./netGuard')
const { describeUpstreamStatus, isFatalUpstreamStatus } = require('./upstreamStatus')
const Logger = new (require('./logger'))()

// An upstream that ends or fails immediately used to be retried in a tight
// loop, which burns CPU and hammers the provider. Retries are spaced out and
// capped instead.
const RETRY_DELAY = 1000
const MAX_CONSECUTIVE_FAILURES = 5

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
    this.stream = new DataStream()

    // Bindings
    this.end = this.end.bind(this)
    this.unsubscribe = this.unsubscribe.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.requestFactory = this.requestFactory.bind(this)
    this.scheduleRetry = this.scheduleRetry.bind(this)

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
    if (this.listeners <= 0) {
      Logger.verbose('No more subscribers.')
      this.listeners = 0
      this.end()
    }
  }

  subscribe () {
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

    myRequest.on('response', (response) => {
      if (response.statusCode === 200) {
        this.failures = 0
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
