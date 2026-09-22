const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { findFfmpeg, isAvailable } = require('./remux')
const Logger = new (require('../logger'))()

// 720p at a low frame rate: a still card costs almost nothing to encode, and
// every player that can show a channel can show this.
const WIDTH = 1280
const HEIGHT = 720
const FRAME_RATE = 10
const BACKGROUND = '0x10141a'
const TITLE_SIZE = 44
const DETAIL_SIZE = 26

// Fonts drawtext can use, in preference order. drawtext needs a real font file
// unless ffmpeg was built with fontconfig, which is not a safe assumption.
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf'
]

let cachedFont
function findFont () {
  if (cachedFont !== undefined) return cachedFont
  cachedFont = null
  for (const candidate of FONT_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) {
        cachedFont = candidate
        break
      }
    } catch (error) {
      // Not this one.
    }
  }
  return cachedFont
}

/**
 * A font path inside a single quoted option.
 *
 * Backslashes become forward slashes, which ffmpeg accepts on Windows too, and
 * the drive letter's colon is escaped. Without that, "C:/Windows/..." is read
 * as the option "C" followed by a new one, and the filter fails to build.
 */
function escapeFontPath (value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').replace(/:/g, '\\:')
}

/**
 * Wraps a long message so it does not run off the side of the screen.
 */
function wrap (text, columns) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const word of words) {
    if (line.length === 0) {
      line = word
    } else if ((line + ' ' + word).length <= columns) {
      line = line + ' ' + word
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/**
 * Builds the drawtext filters, reading the words from files rather than from
 * the filter graph.
 *
 * The message carries a channel name straight from the provider's playlist.
 * Escaping that into a filter graph means getting three parsers right at once,
 * and getting it wrong is silent: ffmpeg still exits zero and simply draws the
 * wrong words, as an apostrophe and a stray percent sign both did here.
 * textfile= takes the bytes verbatim, so only the paths need escaping, and
 * those are ours.
 */
function drawTextFilters (title, detail, font, files) {
  if (!font || !files) return []
  const fontPath = escapeFontPath(font)
  const filters = []
  const titleLines = wrap(title, 42).length
  const detailLines = detail ? Math.min(wrap(detail, 64).length, 4) : 0
  const titleBlock = titleLines * (TITLE_SIZE + 12)
  const detailBlock = detailLines * (DETAIL_SIZE + 10)
  const top = Math.round((HEIGHT - (titleBlock + detailBlock + 18)) / 2)

  if (files.title) {
    filters.push(
      `drawtext=textfile='${escapeFontPath(files.title)}':` +
      `fontfile='${fontPath}':expansion=none:fontcolor=white:fontsize=${TITLE_SIZE}:` +
      `line_spacing=12:x=(w-text_w)/2:y=${top}`
    )
  }
  if (files.detail) {
    filters.push(
      `drawtext=textfile='${escapeFontPath(files.detail)}':` +
      `fontfile='${fontPath}':expansion=none:fontcolor=0xa8b3c4:fontsize=${DETAIL_SIZE}:` +
      `line_spacing=10:x=(w-text_w)/2:y=${top + titleBlock + 18}`
    )
  }
  return filters
}

function slateArgs (title, detail, font, files) {
  const filters = drawTextFilters(title, detail, font, files)
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    // A still colour source and silence, generated locally. Nothing is fetched,
    // so a slate cannot itself reach the network.
    //
    // -re paces both inputs at their own frame rate. Without it lavfi produces
    // frames as fast as the CPU allows, so a few seconds on screen arrives as
    // tens of megabytes and minutes of playing time, which floods the player's
    // buffer and burns a core doing it.
    '-re', '-f', 'lavfi', '-i', `color=c=${BACKGROUND}:s=${WIDTH}x${HEIGHT}:r=${FRAME_RATE}`,
    '-re', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'
  ]
  if (filters.length > 0) {
    args.push('-vf', filters.join(','))
  }
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'stillimage',
    '-pix_fmt', 'yuv420p',
    // A keyframe every second, so a player that joins late paints quickly.
    '-g', String(FRAME_RATE),
    '-c:a', 'aac',
    '-b:a', '64k',
    '-f', 'mpegts',
    'pipe:1'
  )
  return args
}

function writeTextFiles (title, detail) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiptv-slate-'))
  const files = { dir, title: null, detail: null }
  const titleLines = wrap(title, 42)
  const detailLines = wrap(detail, 64).slice(0, 4)
  if (titleLines.length > 0) {
    files.title = path.join(dir, 'title.txt')
    fs.writeFileSync(files.title, titleLines.join('\n'), 'utf8')
  }
  if (detailLines.length > 0) {
    files.detail = path.join(dir, 'detail.txt')
    fs.writeFileSync(files.detail, detailLines.join('\n'), 'utf8')
  }
  return files
}

function removeTextFiles (files) {
  if (!files || !files.dir) return
  try {
    fs.rmSync(files.dir, { recursive: true, force: true })
  } catch (error) {
    Logger.verbose(`Could not remove the slate text files: ${error.message}`)
  }
}

/**
 * Produces an endless MPEG-TS card explaining why a channel is not playing.
 *
 * Handing the player a 502 means Plex shows its own generic failure and the
 * viewer learns nothing. A slate puts the actual reason on the screen, which is
 * the difference between "this is broken" and "your line is already in use".
 *
 * Returns null when ffmpeg is unavailable, so the caller can fall back.
 */
function createSlate (title, detail) {
  if (!isAvailable()) return null
  const binary = findFfmpeg()
  if (!binary) return null

  const font = findFont()
  if (!font) {
    Logger.warn('No usable font was found, so the slate will be shown without text.')
  }

  let files = null
  if (font) {
    try {
      files = writeTextFiles(title, detail)
    } catch (error) {
      Logger.warn(`Could not write the slate text: ${error.message}. It will be shown without text.`)
      files = null
    }
  }

  // spawn with an argument array and no shell: nothing here is parsed as a
  // command line, and the message itself never enters the filter graph at all.
  const child = spawn(binary, slateArgs(title, detail, font, files), { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim()
    if (message.length > 0) Logger.verbose(`slate ffmpeg: ${message.slice(0, 200)}`)
  })
  // ffmpeg reads the files once at start up, but they are only safe to remove
  // once it has exited.
  child.once('close', () => removeTextFiles(files))
  child.once('error', () => removeTextFiles(files))
  return child
}

/**
 * Streams a slate to an HTTP response.
 *
 * Returns false when no slate can be produced, so the caller can fall back to
 * an ordinary error response rather than leaving the viewer with nothing.
 */
function sendSlate (res, title, detail) {
  const child = createSlate(title, detail)
  if (!child) return false

  res.status(200).set({
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store'
  })
  child.stdout.pipe(res)

  // The slate runs until the viewer leaves. Without this, a player that tunes
  // away from a failing channel would leave an ffmpeg behind for ever.
  const stop = () => {
    try {
      child.kill('SIGKILL')
    } catch (error) {
      // Already gone.
    }
  }
  res.on('close', stop)
  res.on('finish', stop)
  child.on('error', (error) => {
    Logger.error(`The slate could not be played: ${error.message}`)
    stop()
    if (!res.headersSent) res.status(502).end()
  })
  return true
}

module.exports = {
  FRAME_RATE,
  HEIGHT,
  WIDTH,
  createSlate,
  drawTextFilters,
  escapeFontPath,
  findFont,
  slateArgs,
  wrap,
  writeTextFiles,
  removeTextFiles,
  sendSlate
}
