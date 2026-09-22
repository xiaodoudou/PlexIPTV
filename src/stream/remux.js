const { spawn, spawnSync } = require('child_process')
const EventEmitter = require('events')
const Logger = new (require('../logger'))()

// Most HLS streams ship MPEG-TS segments, which Plex accepts as-is. A minority
// ship fragmented MP4, which cannot simply be concatenated into a transport
// stream. Those are piped through ffmpeg with `-c copy`: the audio and video
// are repackaged, not re-encoded, so the cost is negligible and the quality is
// untouched.
const FFMPEG_ARGS = [
  '-hide_banner',
  '-loglevel', 'error',
  '-fflags', '+genpts',
  '-i', 'pipe:0',
  '-c', 'copy',
  '-f', 'mpegts',
  'pipe:1'
]

// What ffmpeg is allowed to speak when it opens a stream itself, which it only
// does for RTSP. Without this an RTSP server could steer it somewhere else
// through the session description; `file` is deliberately absent so a hostile
// SDP cannot make it read from the disk.
const RTSP_PROTOCOL_WHITELIST = 'rtsp,rtsps,rtp,udp,tcp,tls,crypto,data'
// ffmpeg expects microseconds.
const RTSP_TIMEOUT_US = 15000000

function rtspArgs (url) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', RTSP_PROTOCOL_WHITELIST,
    // Give up rather than hanging on a source that accepts the socket and then
    // says nothing. -timeout covers the RTSP socket, -rw_timeout the transport
    // underneath it; a watchdog below covers whatever neither of them catches.
    '-timeout', String(RTSP_TIMEOUT_US),
    '-rw_timeout', String(RTSP_TIMEOUT_US),
    '-fflags', '+genpts',
    '-i', url,
    '-c', 'copy',
    '-f', 'mpegts',
    'pipe:1'
  ]
}

let cachedBinary
let probed = false

/**
 * Locates ffmpeg once per process. PLEXIPTV_FFMPEG overrides the lookup for
 * installs that keep it outside PATH.
 */
function findFfmpeg () {
  if (probed) return cachedBinary
  probed = true
  // An explicit opt out, for operators who would rather a channel fail loudly
  // than have ffmpeg started on their behalf.
  const configured = process.env.PLEXIPTV_FFMPEG
  if (configured === 'none' || configured === 'off' || configured === 'disabled') {
    cachedBinary = null
    return null
  }
  const candidates = [configured, 'ffmpeg'].filter(Boolean)
  for (const candidate of candidates) {
    try {
      // No shell: the candidate is passed as the executable, never interpolated
      // into a command line.
      const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 10000 })
      if (!probe.error && probe.status === 0) {
        cachedBinary = candidate
        return cachedBinary
      }
    } catch (error) {
      // try the next candidate
    }
  }
  cachedBinary = null
  return null
}

function isAvailable () {
  return findFfmpeg() !== null
}

/**
 * Wraps an ffmpeg process that turns whatever is written to it into MPEG-TS.
 *
 * Segments are written to ffmpeg's stdin rather than handing it a URL, so
 * every byte still arrives through the guarded HTTP client and ffmpeg never
 * opens a socket of its own. That keeps the SSRF protections in force.
 */
class Remuxer extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.watchdogMs] How long an RTSP source may produce
   *   nothing before it is given up on. Defaults to the window ffmpeg's own
   *   timeouts use. Tests shorten it so the watchdog is what fires rather than
   *   racing ffmpeg at the same value.
   */
  constructor (options = {}) {
    super()
    this.process = null
    this.closed = false
    this.startedAt = 0
    this.sourceUrl = null
    this.firstOutput = false
    this.watchdog = null
    this.watchdogMs = options.watchdogMs || Math.round(RTSP_TIMEOUT_US / 1000)
  }

  /**
   * @param {string} [url] When given, ffmpeg opens this stream itself instead
   *   of reading from stdin. Only used for RTSP, which this process does not
   *   speak. The URL must already have been validated by the caller.
   */
  start (url) {
    const binary = findFfmpeg()
    if (!binary) return false

    this.sourceUrl = url || null
    const args = url ? rtspArgs(url) : FFMPEG_ARGS
    // spawn with an argument array and no shell: nothing here is parsed as a
    // command line, so neither a hostile segment name nor a stream URL can
    // inject anything.
    this.process = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.startedAt = Date.now()

    this.process.stdout.on('data', (chunk) => {
      if (this.closed) return
      if (!this.firstOutput) {
        this.firstOutput = true
        this.clearWatchdog()
      }
      this.emit('data', chunk)
    })

    // ffmpeg's own timeouts do not always fire: a source that accepts the
    // socket and then says nothing can hold it open indefinitely, which would
    // wedge the channel. Nothing out of ffmpeg within the grace period means
    // it is not going to play.
    if (url) {
      this.watchdog = setTimeout(() => {
        this.watchdog = null
        if (this.closed || this.firstOutput) return
        const seconds = Math.round(this.watchdogMs / 1000)
        this.closed = true
        this.killProcess()
        this.emit('error', new Error(`the stream produced nothing within ${seconds}s, so it is not playable`))
      }, this.watchdogMs)
      if (this.watchdog.unref) this.watchdog.unref()
    }
    this.process.stderr.on('data', (chunk) => {
      const message = chunk.toString().trim()
      if (message.length > 0) Logger.verbose(`ffmpeg: ${message.slice(0, 200)}`)
    })
    this.process.on('error', (error) => {
      if (this.closed) return
      this.closed = true
      this.emit('error', new Error(`ffmpeg could not be started: ${error.message}`))
    })
    this.process.on('close', (code) => {
      if (this.closed) return
      this.closed = true
      if (code === 0) return this.emit('end')
      this.emit('error', new Error(`ffmpeg exited with code ${code}`))
    })
    // A broken pipe is normal when a viewer leaves mid-segment.
    this.process.stdin.on('error', () => {})
    return true
  }

  clearWatchdog () {
    if (!this.watchdog) return
    clearTimeout(this.watchdog)
    this.watchdog = null
  }

  killProcess () {
    if (!this.process) return
    const child = this.process
    this.process = null
    try {
      child.stdin.end()
    } catch (error) {
      // already gone
    }
    child.kill('SIGKILL')
  }

  write (chunk) {
    if (this.closed || !this.process || !this.process.stdin.writable) return false
    return this.process.stdin.write(chunk)
  }

  stop () {
    this.clearWatchdog()
    if (this.closed) return
    this.closed = true
    this.killProcess()
  }
}

module.exports = {
  FFMPEG_ARGS,
  RTSP_PROTOCOL_WHITELIST,
  RTSP_TIMEOUT_US,
  rtspArgs,
  Remuxer,
  findFfmpeg,
  isAvailable
}
