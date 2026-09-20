require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const { FFMPEG_ARGS, Remuxer, isAvailable } = require('../remux')

const HAVE_FFMPEG = isAvailable()
const skip = HAVE_FFMPEG ? false : 'ffmpeg is not installed on this machine'

test('the ffmpeg invocation copies streams rather than re-encoding them', () => {
  // The whole point: fMP4 and MPEG-TS carry the same H.264/AAC, so this is a
  // repackaging job. Re-encoding would cost CPU and quality for nothing.
  const args = FFMPEG_ARGS.join(' ')
  assert.match(args, /-c copy/)
  assert.match(args, /-f mpegts/)
  assert.match(args, /-i pipe:0/, 'input arrives over a pipe, never as a URL')
  assert.match(args, /pipe:1/, 'output goes to a pipe')
  // Handing ffmpeg a URL would let it open sockets outside the SSRF guard.
  assert.ok(!args.includes('http'), 'ffmpeg is never given a URL')
})

test('ffmpeg is looked up without a shell', () => {
  // spawn/spawnSync with an argument array means nothing is parsed as a
  // command line, so a hostile segment name cannot inject anything.
  const source = require('node:fs').readFileSync(require.resolve('../remux.js'), 'utf8')
  assert.ok(!source.includes('shell: true'), 'no shell')
  assert.ok(!source.includes('exec('), 'no exec()')
})

test('an explicit opt out disables remuxing', () => {
  // Checked in a child process, because availability is probed once and cached.
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(require("./remux").isAvailable() ? 1 : 0)'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: Object.assign({}, process.env, { PLEXIPTV_FFMPEG: 'none', PLEXIPTV_LOGDIR: process.env.PLEXIPTV_LOGDIR }),
    timeout: 20000
  })
  assert.strictEqual(probe.status, 0, 'PLEXIPTV_FFMPEG=none must report ffmpeg as unavailable')
})

test('a missing ffmpeg binary is reported, not crashed on', () => {
  const probe = spawnSync(process.execPath, ['-e', 'process.exit(require("./remux").isAvailable() ? 1 : 0)'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PLEXIPTV_FFMPEG: 'definitely-not-a-real-binary-xyz',
      PATH: '',
      Path: '',
      PLEXIPTV_LOGDIR: process.env.PLEXIPTV_LOGDIR
    }),
    timeout: 20000
  })
  assert.strictEqual(probe.status, 0, 'a bogus binary must not be reported as available')
})

test('fragmented MP4 in, MPEG-TS out', { skip }, async () => {
  // Build a real fMP4 stream with ffmpeg, then feed it through the Remuxer and
  // check what comes out the other side is a transport stream.
  const built = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast',
    '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4', 'pipe:1'
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 })
  assert.strictEqual(built.status, 0, 'test fixture built')
  const fragmented = built.stdout
  assert.notStrictEqual(fragmented[0], 0x47, 'the fixture is not already a transport stream')

  const remuxer = new Remuxer()
  const chunks = []
  remuxer.on('data', (chunk) => chunks.push(chunk))
  const finished = new Promise((resolve) => {
    remuxer.on('end', resolve)
    remuxer.on('error', resolve)
  })

  assert.strictEqual(remuxer.start(), true)
  remuxer.write(fragmented)
  remuxer.process.stdin.end()
  await finished

  const output = Buffer.concat(chunks)
  assert.ok(output.length > 0, 'ffmpeg produced output')
  assert.strictEqual(output[0], 0x47, 'output starts with the MPEG-TS sync byte')
  assert.strictEqual(output[188], 0x47, 'and the next packet boundary is intact')
})

test('stop() kills the process and stops emitting', { skip }, async () => {
  const remuxer = new Remuxer()
  remuxer.on('error', () => {})
  assert.strictEqual(remuxer.start(), true)
  const child = remuxer.process
  remuxer.stop()
  assert.strictEqual(remuxer.closed, true)
  assert.strictEqual(remuxer.process, null)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.strictEqual(child.killed, true, 'the ffmpeg process was killed')
})

test('writing after stop is refused rather than throwing', { skip }, () => {
  const remuxer = new Remuxer()
  remuxer.on('error', () => {})
  remuxer.start()
  remuxer.stop()
  assert.doesNotThrow(() => {
    assert.strictEqual(remuxer.write(Buffer.from('x')), false)
  })
})
