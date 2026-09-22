require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { HlsReader, parseManifest } = require('../src/stream/hls')
const { isAvailable } = require('../src/stream/remux')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The test origins run on loopback, which the SSRF guard blocks by design.
const LOCAL = { allowPrivateNetwork: true }

// A real fragmented MP4 HLS set, built once by ffmpeg, so the fMP4 path is
// exercised against genuine bytes rather than a hand-written stub.
const FIXTURE = (() => {
  if (!isAvailable()) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiptv-fmp4-'))
  // Run with cwd set to the temp directory: ffmpeg writes the fMP4 init
  // segment relative to the working directory, not to the playlist.
  const built = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15',
    '-f', 'hls', '-hls_time', '1', '-hls_segment_type', 'fmp4',
    '-hls_list_size', '0', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', 'seg%d.m4s',
    'live.m3u8'
  ], { cwd: dir, timeout: 120000 })
  if (built.status !== 0) return null
  const segments = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.m4s'))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
  if (segments.length === 0 || !fs.existsSync(path.join(dir, 'init.mp4'))) return null
  return {
    dir,
    init: fs.readFileSync(path.join(dir, 'init.mp4')),
    segments: segments.map((f) => fs.readFileSync(path.join(dir, f)))
  }
})()

function tsSegment (marker) {
  const chunk = Buffer.alloc(376, marker)
  chunk[0] = 0x47
  chunk[188] = 0x47
  return chunk
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('a media playlist is parsed into its segments', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:1776',
    '#EXT-X-TARGETDURATION:12',
    '#EXTINF:11.520000,',
    '/hls/abc/506638_1776.ts',
    '#EXTINF:11.520000,',
    '/hls/def/506638_1777.ts',
    ''
  ].join('\n')
  const manifest = parseManifest(body, 'http://185.245.0.224/live/play/token/506638')

  assert.strictEqual(manifest.type, 'media')
  assert.strictEqual(manifest.mediaSequence, 1776)
  assert.strictEqual(manifest.targetDuration, 12)
  assert.strictEqual(manifest.ended, false)
  // Absolute paths resolve against the host the manifest came from, which is
  // the post-redirect host rather than the one originally requested.
  assert.deepStrictEqual(manifest.segments.map((s) => s.url), [
    'http://185.245.0.224/hls/abc/506638_1776.ts',
    'http://185.245.0.224/hls/def/506638_1777.ts'
  ])
  assert.strictEqual(manifest.segments[0].duration, 11.52)
})

test('relative segment paths resolve against the manifest URL', () => {
  const manifest = parseManifest('#EXTM3U\n#EXTINF:4,\nseg1.ts\n', 'http://example.com/a/b/live.m3u8')
  assert.deepStrictEqual(manifest.segments.map((s) => s.url), ['http://example.com/a/b/seg1.ts'])
})

test('a master playlist is parsed into its variants', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
    'high.m3u8',
    ''
  ].join('\n')
  const manifest = parseManifest(body, 'http://example.com/master.m3u8')
  assert.strictEqual(manifest.type, 'master')
  assert.strictEqual(manifest.variants.length, 2)
  assert.strictEqual(manifest.variants[1].bandwidth, 3000000)
  assert.strictEqual(manifest.segments.length, 0)
})

test('EXT-X-ENDLIST marks the playlist finished', () => {
  const manifest = parseManifest('#EXTM3U\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n', 'http://example.com/l.m3u8')
  assert.strictEqual(manifest.ended, true)
})

test('a malformed manifest does not throw', () => {
  assert.doesNotThrow(() => parseManifest('', 'http://example.com/l.m3u8'))
  assert.doesNotThrow(() => parseManifest('#EXTM3U\n#EXTINF:notanumber,\nnot a uri\n', 'http://example.com/l.m3u8'))
  assert.doesNotThrow(() => parseManifest(null, 'http://example.com/l.m3u8'))
})

test('the reader starts at the live edge and then follows new segments', async (t) => {
  let sequence = 10
  const served = []
  const { server, port } = await listen((req, res) => {
    if (req.url.indexOf('/live.m3u8') === 0) {
      const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXT-X-MEDIA-SEQUENCE:' + sequence]
      for (let i = 0; i < 3; i++) {
        lines.push('#EXTINF:1.0,')
        lines.push('/seg/' + (sequence + i) + '.ts')
      }
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
      return res.end(lines.join('\n'))
    }
    const id = Number(req.url.replace('/seg/', '').replace('.ts', ''))
    served.push(id)
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    res.end(tsSegment(id % 256))
  })
  t.after(() => server.close())

  const reader = new HlsReader('http://127.0.0.1:' + port + '/live.m3u8', LOCAL)
  const chunks = []
  reader.on('data', (chunk) => chunks.push(chunk))
  reader.on('error', () => {})
  reader.start()

  // First pass: the window that already exists is skipped rather than
  // replayed, so a channel does not start half a minute behind.
  await settle(600)
  assert.deepStrictEqual(served, [], 'nothing downloaded from the initial window')

  // The window rolls forward; the new segments should be picked up.
  sequence = 13
  await settle(2500)
  reader.stop()

  assert.ok(served.length > 0, 'new segments were downloaded')
  assert.deepStrictEqual(served, served.slice().sort((a, b) => a - b), 'segments delivered in order')
  assert.strictEqual(new Set(served).size, served.length, 'no segment downloaded twice')
  assert.ok(chunks.length > 0, 'segment bytes were emitted')
  assert.strictEqual(Buffer.concat(chunks)[0], 0x47, 'emitted bytes are a transport stream')
})

test('the reader follows a master playlist to its highest bandwidth variant', async (t) => {
  let picked = null
  const { server, port } = await listen((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
      return res.end([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=400000',
        'low.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000',
        'high.m3u8'
      ].join('\n'))
    }
    if (req.url.indexOf('.m3u8') !== -1) {
      picked = req.url
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1.0,\n/seg/1.ts\n')
    }
    res.writeHead(200)
    res.end(tsSegment(1))
  })
  t.after(() => server.close())

  const reader = new HlsReader('http://127.0.0.1:' + port + '/master.m3u8', LOCAL)
  reader.on('error', () => {})
  reader.on('data', () => {})
  reader.start()
  await settle(700)
  reader.stop()

  assert.strictEqual(picked, '/high.m3u8', 'the highest bandwidth rendition is chosen')
})

test('stop() halts polling and leaves no timer behind', async (t) => {
  let manifestHits = 0
  const { server, port } = await listen((req, res) => {
    manifestHits++
    res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
    res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:1.0,\n/seg/1.ts\n')
  })
  t.after(() => server.close())

  const reader = new HlsReader('http://127.0.0.1:' + port + '/live.m3u8', LOCAL)
  reader.on('error', () => {})
  reader.on('data', () => {})
  reader.start()
  await settle(1400)
  reader.stop()
  const afterStop = manifestHits
  await settle(1600)

  assert.strictEqual(manifestHits, afterStop, 'no polling after stop()')
  assert.strictEqual(reader.timer, null)
})

test('an unreachable playlist reports an error rather than throwing', async () => {
  const reader = new HlsReader('http://127.0.0.1:1/live.m3u8', LOCAL)
  const error = await new Promise((resolve) => {
    reader.on('error', resolve)
    reader.on('data', () => {})
    reader.start()
  })
  assert.ok(error instanceof Error)
  reader.stop()
})

test('a playlist on a private address is refused unless opted in', async () => {
  // The SSRF guard still applies to every HLS fetch, manifest and segment.
  const reader = new HlsReader('http://169.254.169.254/live.m3u8', {})
  const error = await new Promise((resolve) => {
    reader.on('error', resolve)
    reader.on('data', () => {})
    reader.start()
  })
  assert.match(error.message, /private network address/)
  reader.stop()
})

test('fragmented MP4 segments are routed through ffmpeg, not forwarded raw', async (t) => {
  // HLS segments are usually MPEG-TS and need no work. fMP4 segments cannot be
  // concatenated into a transport stream, so they go through ffmpeg -c copy:
  // a repackaging, not a re-encode.
  if (!FIXTURE) return t.skip('ffmpeg is not installed on this machine')

  let index = 0
  const { server, port } = await listen((req, res) => {
    if (req.url.indexOf('.m3u8') !== -1) {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
      return res.end([
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:' + index,
        '#EXT-X-MAP:URI="/init.mp4"',
        '#EXTINF:1.0,',
        '/seg' + index + '.m4s',
        ''
      ].join('\n'))
    }
    if (req.url.indexOf('init') !== -1) {
      res.writeHead(200, { 'Content-Type': 'video/mp4' })
      return res.end(FIXTURE.init)
    }
    const wanted = Number(req.url.replace('/seg', '').replace('.m4s', ''))
    res.writeHead(200, { 'Content-Type': 'video/mp4' })
    res.end(FIXTURE.segments[wanted % FIXTURE.segments.length])
  })
  t.after(() => server.close())

  const reader = new HlsReader('http://127.0.0.1:' + port + '/live.m3u8', LOCAL)
  const emitted = []
  reader.on('data', (chunk) => emitted.push(chunk))
  reader.on('error', () => {})
  reader.start()

  // Walk the live window forward so several fragments are delivered.
  for (let step = 0; step < 5; step++) {
    await settle(1100)
    index = index + 1
  }
  await settle(1500)
  reader.stop()

  assert.strictEqual(reader.mode, 'remux', 'the reader switched to repackaging')
  const output = Buffer.concat(emitted)
  assert.ok(output.length > 0, 'ffmpeg produced output')
  assert.strictEqual(output[0], 0x47, 'what reaches the client is a transport stream')
  assert.strictEqual(output[188], 0x47, 'packet boundaries are intact')
  assert.strictEqual(output.indexOf(Buffer.from('styp')), -1, 'no fMP4 boxes leak through')
})

test('TS segments are passed through untouched, so no transcoding is involved', async (t) => {
  let sequence = 40
  const { server, port } = await listen((req, res) => {
    if (req.url.indexOf('.m3u8') !== -1) {
      res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:' + sequence + '\n#EXTINF:1.0,\n/seg/' + sequence + '.ts\n')
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    res.end(tsSegment(0xAB))
  })
  t.after(() => server.close())

  const reader = new HlsReader('http://127.0.0.1:' + port + '/live.m3u8', LOCAL)
  const chunks = []
  reader.on('data', (chunk) => chunks.push(chunk))
  reader.on('error', () => {})
  reader.start()
  await settle(600)
  sequence = 41
  await settle(2200)
  reader.stop()

  const body = Buffer.concat(chunks)
  assert.ok(body.length > 0, 'segments were delivered')
  assert.strictEqual(body[0], 0x47, 'output is a transport stream')
  assert.strictEqual(body[188], 0x47, 'packet boundaries are intact')
  // Byte-for-byte identical to what the origin served: no re-encoding.
  assert.strictEqual(body.slice(0, 376).equals(tsSegment(0xAB)), true)
})
