const { isolate } = require('./helpers')
const tmpDir = isolate()
process.env.DEBUG = 'plexiptv:*:verbose,plexiptv:*:error,plexiptv:*:warn,plexiptv:*:info'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const net = require('node:net')
const Worker = require('../worker')
const { parsePlaylist } = require('../playlist')
const { assertSafeUrl, assertStreamUrl, isRtsp } = require('../netGuard')
const { RTSP_PROTOCOL_WHITELIST, isAvailable, rtspArgs } = require('../remux')

const LOG_FILE = path.join(tmpDir, 'logs.txt')
const REPO = path.join(__dirname, '..')

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readLog () {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8')
  } catch (error) {
    return ''
  }
}

test('rtsp is a playable channel protocol but still not fetchable over HTTP', () => {
  assert.ok(assertStreamUrl('rtsp://cdn.example.com/live'))
  assert.ok(assertStreamUrl('rtsps://cdn.example.com/live'))
  assert.strictEqual(isRtsp('rtsp://a/b'), true)
  assert.strictEqual(isRtsp('http://a/b'), false)
  // The HTTP client must never be handed an RTSP URL.
  assert.throws(() => assertSafeUrl('rtsp://cdn.example.com/live'), /unsupported protocol/)
})

test('rtsp does not reopen the door to other protocols', () => {
  for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.throws(() => assertStreamUrl(url), /unsupported protocol|malformed/i, `${url} must stay refused`)
  }
})

test('an rtsp channel on a private address still needs the opt in', () => {
  // Freebox and most ISP boxes are on the LAN, so this is the common case.
  assert.throws(() => assertStreamUrl('rtsp://192.168.1.254/fbxtv_pub/stream'), /private network address/)
  assert.ok(assertStreamUrl('rtsp://192.168.1.254/fbxtv_pub/stream', { allowPrivateNetwork: true }))
})

test('rtsp entries make it into the lineup', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1,France 2',
    'rtsp://mafreebox.example.fr/fbxtv_pub/stream?namespace=1&service=201',
    '#EXTINF:-1,Hostile',
    'file:///etc/passwd',
    ''
  ].join('\n')
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false })
  assert.deepStrictEqual(channels.map((line) => line.name), ['France 2'])
  assert.match(channels[0].url, /^rtsp:\/\//)
})

test('ffmpeg is told to copy, not re-encode, and is fenced to rtsp protocols', () => {
  const args = rtspArgs('rtsp://cdn.example.com/live')
  const joined = args.join(' ')
  assert.match(joined, /-c copy/, 'repackage, never re-encode')
  assert.match(joined, /-f mpegts/)
  assert.match(joined, /-protocol_whitelist /)
  assert.strictEqual(args[args.indexOf('-i') + 1], 'rtsp://cdn.example.com/live')

  const allowed = RTSP_PROTOCOL_WHITELIST.split(',')
  // ffmpeg opens this connection itself, so a hostile session description must
  // not be able to steer it at the local disk or anywhere unexpected.
  assert.ok(!allowed.includes('file'), 'file must not be reachable from an SDP')
  assert.ok(!allowed.includes('http'), 'no protocol hopping out of rtsp')
  assert.ok(allowed.includes('rtsp') && allowed.includes('rtp') && allowed.includes('udp'))
})

test('the URL is passed as an argument, never through a shell', () => {
  const source = fs.readFileSync(path.join(REPO, 'remux.js'), 'utf8')
  assert.ok(!source.includes('shell: true'))
  assert.ok(!source.includes('exec('))
  // A URL containing shell metacharacters is just an opaque argv entry.
  const args = rtspArgs('rtsp://host/live;rm -rf /')
  assert.strictEqual(args[args.indexOf('-i') + 1], 'rtsp://host/live;rm -rf /')
})

test('without ffmpeg an rtsp channel explains itself instead of failing silently', () => {
  // Availability is probed once per process, so this runs in a child.
  const script = `
    const Worker = require('./worker')
    const w = new Worker('g', {
      channel: '1', name: 'France 2',
      url: 'rtsp://cdn.example.com/live',
      internalUrl: 'http://localhost:1234/channel/1'
    }, { retryDelay: 50, maxConsecutiveFailures: 1, lingerMs: 0 })
    w.on('upstream-error', (status, explanation) => {
      console.log(JSON.stringify({ status, explanation }))
      process.exit(0)
    })
    setTimeout(() => { console.log('NO_ERROR_EMITTED'); process.exit(1) }, 5000)
  `
  const probe = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO,
    env: Object.assign({}, process.env, {
      PLEXIPTV_FFMPEG: 'none',
      PLEXIPTV_LOGDIR: tmpDir,
      DEBUG: 'plexiptv:nothing'
    }),
    encoding: 'utf8',
    timeout: 30000
  })
  assert.strictEqual(probe.status, 0, `child failed: ${probe.stdout} ${probe.stderr}`)
  const reported = JSON.parse(probe.stdout.trim().split('\n').pop())
  assert.match(reported.explanation, /ffmpeg/)
  assert.match(reported.explanation, /RTSP/)
})

test('an unreachable rtsp source fails cleanly and stops retrying', {
  skip: isAvailable() ? false : 'ffmpeg is not installed on this machine'
}, async () => {
  // A real ffmpeg spawn against a port with nothing on it: it should report,
  // retry a bounded number of times, then give up without taking anything down.
  const worker = new Worker('guid-rtsp-dead', {
    channel: '1',
    name: 'Dead RTSP',
    // Port 9 is discard; nothing will answer RTSP there.
    url: 'rtsp://127.0.0.1:9/live',
    internalUrl: 'http://localhost:1234/channel/1'
  }, { allowPrivateNetwork: true, retryDelay: 50, maxConsecutiveFailures: 1, lingerMs: 0 })

  const ended = await Promise.race([
    new Promise((resolve) => worker.once('end', () => resolve('ended'))),
    settle(60000).then(() => 'timeout')
  ])
  worker.stream.end()
  await settle(500)

  assert.strictEqual(ended, 'ended', 'it gave up rather than retrying forever')
  assert.strictEqual(worker.rtsp, null, 'the ffmpeg process was released')
  assert.ok(readLog().includes('Dead RTSP'), 'the failure names the channel')
})

test('an rtsp URL is redacted in the log like any other', async () => {
  const worker = new Worker('guid-rtsp-creds', {
    channel: '2',
    name: 'Creds',
    url: 'rtsp://testuser0000:testpass0000@cdn.example.com/live',
    internalUrl: 'http://localhost:1234/channel/2'
  }, { retryDelay: 50, maxConsecutiveFailures: 1, lingerMs: 0 })

  await settle(600)
  worker.stream.end()
  await settle(200)

  const log = readLog()
  assert.ok(!log.includes('testpass0000'), 'the password must never be logged')
  assert.ok(!log.includes('testuser0000'), 'the username must never be logged')
})

test('a source that accepts the socket and says nothing is given up on', {
  skip: isAvailable() ? false : 'ffmpeg is not installed on this machine'
}, async () => {
  // ffmpeg's own timeouts do not reliably fire here, so the Remuxer keeps its
  // own watchdog. Without it a wedged provider holds the channel forever.
  const { Remuxer } = require('../remux')
  // A listener that accepts the connection and then says nothing, which is the
  // case the watchdog exists for. A closed port is not the same thing: on Linux
  // the connect is refused at once, ffmpeg exits before the watchdog is due,
  // and the test passes or fails on the platform's refusal timing instead.
  const accepted = []
  const silent = net.createServer((socket) => accepted.push(socket))
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve))
  const { port } = silent.address()
  // Well inside ffmpeg's own timeout, so the watchdog is what gives up.
  const watchdogMs = 2000
  const remuxer = new Remuxer({ watchdogMs })
  const started = Date.now()
  remuxer.on('data', () => {})
  const error = await new Promise((resolve) => {
    remuxer.on('error', resolve)
    remuxer.on('end', () => resolve(new Error('ended')))
    remuxer.start(`rtsp://127.0.0.1:${port}/live`)
  })
  remuxer.stop()
  for (const socket of accepted) socket.destroy()
  silent.close()

  const elapsed = Date.now() - started
  assert.match(error.message, /produced nothing/)
  assert.ok(elapsed < watchdogMs + 10000, `gave up in ${elapsed}ms`)
  assert.strictEqual(remuxer.watchdog, null, 'the watchdog is cleared')
})

test('the watchdog does not fire once the stream is producing output', {
  skip: isAvailable() ? false : 'ffmpeg is not installed on this machine'
}, async () => {
  // Piped input has no watchdog at all; this guards against it being armed for
  // the normal fMP4 path, where a slow first segment would kill a good stream.
  const { Remuxer } = require('../remux')
  const remuxer = new Remuxer()
  remuxer.on('data', () => {})
  remuxer.on('error', () => {})
  assert.strictEqual(remuxer.start(), true)
  assert.strictEqual(remuxer.watchdog, null, 'no watchdog when reading from a pipe')
  remuxer.stop()
})
