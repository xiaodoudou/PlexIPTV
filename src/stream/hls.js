const EventEmitter = require('events')
const { fetchText, streamRequest } = require('../net/httpClient')
const { redactUrl } = require('../net/netGuard')
const { looksLikeTransportStream } = require('./payload')
const { Remuxer, isAvailable } = require('./remux')
const Logger = new (require('../logger'))()

// A live playlist is re-read on this fraction of its target duration, so new
// segments are picked up before the player runs dry.
const REFRESH_FACTOR = 0.5
const MIN_REFRESH_MS = 1000
const MAX_REFRESH_MS = 10000
// Guards against a master playlist that points at another master playlist.
const MAX_VARIANT_DEPTH = 3
// How many segments back from the live edge a channel starts.
const START_SEGMENTS = 1
// A source that resolves and then never yields a segment used to leave the
// viewer on an open socket with no response at all. This is the HLS equivalent
// of the RTSP watchdog: past this, the channel is reported as unplayable.
const NO_DATA_TIMEOUT_MS = 20000
// A live window is short; this only bounds the memory used for de-duplication.
const MAX_REMEMBERED_SEGMENTS = 512

/**
 * Parses an m3u8 manifest into either its variants (a master playlist) or its
 * segments (a media playlist). URIs are resolved against baseUrl, which must
 * be the URL the manifest was actually fetched from, after redirects.
 */
function parseManifest (text, baseUrl) {
  const lines = String(text).split(/\r?\n/)
  const variants = []
  const segments = []
  let targetDuration = 0
  let mediaSequence = 0
  let ended = false
  let pendingVariant = null
  let pendingDuration = 0
  let map = null

  const resolve = (uri) => {
    try {
      return new URL(uri, baseUrl).toString()
    } catch (error) {
      return null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const bandwidth = line.match(/[^-]BANDWIDTH=(\d+)/) || line.match(/^#EXT-X-STREAM-INF:BANDWIDTH=(\d+)/)
        pendingVariant = { bandwidth: bandwidth ? Number(bandwidth[1]) : 0 }
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = Number(line.split(':')[1]) || 0
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.split(':')[1]) || 0
      } else if (line.startsWith('#EXTINF:')) {
        pendingDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0
      } else if (line.startsWith('#EXT-X-MAP:')) {
        // Fragmented MP4 streams carry their ftyp/moov here; ffmpeg needs it
        // before any fragment will decode.
        const uri = line.match(/URI="([^"]+)"/)
        if (uri) map = resolve(uri[1])
      } else if (line.startsWith('#EXT-X-ENDLIST')) {
        ended = true
      }
      continue
    }

    const url = resolve(line)
    if (url === null) continue
    if (pendingVariant) {
      variants.push({ url, bandwidth: pendingVariant.bandwidth })
      pendingVariant = null
    } else {
      segments.push({ url, duration: pendingDuration })
      pendingDuration = 0
    }
  }

  return {
    type: variants.length > 0 ? 'master' : 'media',
    variants,
    segments,
    targetDuration,
    mediaSequence,
    map,
    ended
  }
}

/**
 * Reads a live HLS playlist and emits its segments as one continuous byte
 * stream, which is what Plex expects from an HDHomeRun tuner.
 *
 * Providers that hand out an m3u8 rather than a raw transport stream were
 * previously unplayable: the manifest itself was forwarded to Plex, which
 * reported "Unable to tune channel".
 */
class HlsReader extends EventEmitter {
  constructor (url, options) {
    super()
    this.url = url
    this.options = options || {}
    this.stopped = false
    this.timer = null
    this.fetching = false
    this.nextSequence = null
    this.seen = new Set()
    this.seenOrder = []
    this.mode = 'unknown'
    this.remuxer = null
    this.initSent = null
    this.produced = false
    this.noDataTimer = null
    this.noDataTimeoutMs = this.options.noDataTimeoutMs != null
      ? this.options.noDataTimeoutMs
      : NO_DATA_TIMEOUT_MS

    this.start = this.start.bind(this)
    this.stop = this.stop.bind(this)
    this.refresh = this.refresh.bind(this)
  }

  async start () {
    this.armNoDataWatchdog()
    try {
      this.url = await this.resolveVariant(this.url, MAX_VARIANT_DEPTH)
    } catch (error) {
      this.clearNoDataWatchdog()
      if (!this.stopped) this.emit('error', error)
      return
    }
    this.refresh()
  }

  /**
   * Gives up on a source that resolves but never produces video.
   *
   * A playlist that is really another channel list, or one whose segment window
   * never advances, otherwise leaves refresh() looping for ever: no bytes, no
   * error, and a viewer holding an open socket that never receives a response.
   */
  armNoDataWatchdog () {
    if (this.noDataTimeoutMs <= 0 || this.noDataTimer) return
    this.noDataTimer = setTimeout(() => {
      this.noDataTimer = null
      if (this.stopped || this.produced) return
      const seconds = Math.round(this.noDataTimeoutMs / 1000)
      const error = new Error(
        `the channel produced no video within ${seconds}s. The source resolved but never delivered a segment, which usually means the URL is a channel list rather than a stream, or the provider stopped publishing it.`
      )
      // Retrying will not help: the source answered, it simply is not a
      // stream. Retried like an ordinary failure it would take nearly two
      // minutes to give up, by which time every player has walked away.
      error.fatal = true
      this.emit('error', error)
    }, this.noDataTimeoutMs)
    if (this.noDataTimer.unref) this.noDataTimer.unref()
  }

  clearNoDataWatchdog () {
    if (!this.noDataTimer) return
    clearTimeout(this.noDataTimer)
    this.noDataTimer = null
  }

  /**
   * Follows a master playlist down to a media playlist, picking the highest
   * bandwidth rendition on the way.
   */
  async resolveVariant (url, depth) {
    if (depth <= 0) throw new Error(`Too many nested playlists at ${redactUrl(url)}`)
    const body = await fetchText(url, this.requestOptions())
    const manifest = parseManifest(body, url)
    if (manifest.type !== 'master') return url
    if (manifest.variants.length === 0) throw new Error(`Empty master playlist at ${redactUrl(url)}`)
    const best = manifest.variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0]
    Logger.verbose(`Following HLS variant (${best.bandwidth || 'unknown'} bps)`)
    return this.resolveVariant(best.url, depth - 1)
  }

  requestOptions () {
    return {
      headers: this.options.headers,
      allowPrivateNetwork: Boolean(this.options.allowPrivateNetwork)
    }
  }

  scheduleRefresh (targetDuration) {
    if (this.stopped) return
    const base = (targetDuration || 6) * 1000 * REFRESH_FACTOR
    const delay = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, base))
    this.timer = setTimeout(this.refresh, delay)
    if (this.timer.unref) this.timer.unref()
  }

  async refresh () {
    if (this.stopped || this.fetching) return
    this.fetching = true
    let manifest = null
    try {
      const body = await fetchText(this.url, this.requestOptions())
      manifest = parseManifest(body, this.url)
      await this.pump(manifest)
    } catch (error) {
      this.fetching = false
      if (!this.stopped) this.emit('error', error)
      return
    }
    this.fetching = false
    if (this.stopped) return
    if (manifest && manifest.ended) {
      this.emit('end')
      return
    }
    this.scheduleRefresh(manifest ? manifest.targetDuration : 0)
  }

  /**
   * Downloads every segment newer than the last one delivered, in order.
   */
  async pump (manifest) {
    // On the first pass, start START_SEGMENTS back from the live edge.
    //
    // Skipping the window entirely meant nothing was delivered until the next
    // refresh came round, which put roughly twelve seconds of black screen in
    // front of every channel change. Players that give up before then look as
    // though the channel is dead. Starting one segment back puts picture on
    // screen at once, typically two to six seconds behind live, which is not
    // noticeable on a television channel.
    if (this.nextSequence === null) {
      this.nextSequence = manifest.mediaSequence + Math.max(0, manifest.segments.length - START_SEGMENTS)
    }

    let sequence = manifest.mediaSequence
    for (const segment of manifest.segments) {
      const current = sequence
      sequence = sequence + 1
      if (this.stopped) return

      if (current < this.nextSequence) continue
      if (this.seen.has(segment.url)) continue

      const body = await this.fetchSegment(segment.url)
      this.remember(segment.url)
      this.nextSequence = current + 1
      if (body && body.length > 0) await this.deliver(body, manifest)
    }
  }

  /**
   * Decides once whether the segments can be passed straight through, then
   * routes every later segment the same way.
   */
  async deliver (body, manifest) {
    if (this.stopped) return

    if (this.mode === 'unknown') {
      if (looksLikeTransportStream(body)) {
        // The common case: HLS segments are already MPEG-TS, which is exactly
        // what Plex wants, so they are forwarded byte for byte.
        this.mode = 'ts'
      } else if (isAvailable()) {
        Logger.info('Segments are fragmented MP4; repackaging them as MPEG-TS with ffmpeg (-c copy, no re-encoding).')
        if (!this.startRemuxer()) return
        this.mode = 'remux'
        await this.sendInitSegment(manifest)
      } else {
        this.emit('error', new Error(
          'This channel uses fragmented MP4 HLS segments, which have to be repackaged as a transport stream. ' +
          'Install ffmpeg and put it on PATH (or set PLEXIPTV_FFMPEG), or ask your provider for a TS output URL.'
        ))
        this.stop()
        return
      }
    }

    if (this.stopped) return
    if (this.mode === 'ts') {
      this.noteProduced()
      this.emit('data', body)
    } else if (this.remuxer) {
      this.remuxer.write(body)
    }
  }

  startRemuxer () {
    const remuxer = new Remuxer()
    remuxer.on('data', (chunk) => {
      if (this.stopped) return
      this.noteProduced()
      this.emit('data', chunk)
    })
    remuxer.on('error', (error) => {
      if (this.stopped) return
      this.emit('error', error)
    })
    if (!remuxer.start()) {
      this.emit('error', new Error('ffmpeg is required to repackage this channel but could not be started.'))
      this.stop()
      return false
    }
    this.remuxer = remuxer
    return true
  }

  /**
   * Fragmented MP4 fragments do not decode without the ftyp/moov boxes that
   * #EXT-X-MAP points at, so that has to reach ffmpeg first.
   */
  async sendInitSegment (manifest) {
    if (!manifest.map || this.initSent === manifest.map) return
    const body = await this.fetchSegment(manifest.map)
    if (body && body.length > 0 && this.remuxer) {
      this.remuxer.write(body)
      this.initSent = manifest.map
    }
  }

  remember (url) {
    this.seen.add(url)
    this.seenOrder.push(url)
    while (this.seenOrder.length > MAX_REMEMBERED_SEGMENTS) {
      this.seen.delete(this.seenOrder.shift())
    }
  }

  /**
   * Downloads one segment in full. Segments are fetched through the guarded
   * HTTP client and handed to ffmpeg over a pipe, so ffmpeg never opens a
   * socket itself and the SSRF protections stay in force.
   */
  fetchSegment (url) {
    return new Promise((resolve) => {
      if (this.stopped) return resolve(null)
      const request = streamRequest(url, this.requestOptions())
      this.segmentRequest = request
      const chunks = []
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('error', (error) => {
        // One bad segment should not kill the channel; live streams recover.
        Logger.warn(`Skipping an HLS segment: ${error.message}`)
        finish(null)
      })
      request.on('end', () => finish(Buffer.concat(chunks)))
    })
  }

  noteProduced () {
    if (this.produced) return
    this.produced = true
    this.clearNoDataWatchdog()
  }

  stop () {
    if (this.stopped) return
    this.stopped = true
    this.clearNoDataWatchdog()
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.segmentRequest) this.segmentRequest.abort()
    if (this.remuxer) {
      this.remuxer.stop()
      this.remuxer = null
    }
  }
}

module.exports = {
  HlsReader,
  MAX_VARIANT_DEPTH,
  parseManifest
}
