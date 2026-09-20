const { spawn, spawnSync } = require('child_process')
const EventEmitter = require('events')
const Logger = new (require('./logger'))()

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
  constructor () {
    super()
    this.process = null
    this.closed = false
    this.startedAt = 0
  }

  start () {
    const binary = findFfmpeg()
    if (!binary) return false

    // spawn with an argument array and no shell: nothing here is parsed as a
    // command line, so a hostile segment name cannot inject anything.
    this.process = spawn(binary, FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.startedAt = Date.now()

    this.process.stdout.on('data', (chunk) => {
      if (!this.closed) this.emit('data', chunk)
    })
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

  write (chunk) {
    if (this.closed || !this.process || !this.process.stdin.writable) return false
    return this.process.stdin.write(chunk)
  }

  stop () {
    if (this.closed) return
    this.closed = true
    if (!this.process) return
    try {
      this.process.stdin.end()
    } catch (error) {
      // already gone
    }
    this.process.kill('SIGKILL')
    this.process = null
  }
}

module.exports = {
  FFMPEG_ARGS,
  Remuxer,
  findFfmpeg,
  isAvailable
}
