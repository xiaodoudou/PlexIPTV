const { isolate } = require('./helpers')
const tmpDir = isolate()
// This file asserts on what actually lands in the log file, so logging is on.
process.env.DEBUG = 'plexiptv:*:verbose,plexiptv:*:error,plexiptv:*:warn,plexiptv:*:info'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const Worker = require('../worker')

const LOG_FILE = path.join(tmpDir, 'logs.txt')
// Entirely synthetic credentials: never put a real subscription in the repo.
const FAKE_USERNAME = 'testuser0000'
const FAKE_PASSWORD = 'testpass0000'
const CREDENTIALED_URL = `http://provider.example/get.php?username=${FAKE_USERNAME}&password=${FAKE_PASSWORD}&type=m3u_plus`

function readLog () {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8')
  } catch (error) {
    return ''
  }
}

function settle (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('the upstream URL never reaches the log file in clear text', async () => {
  const worker = new Worker('guid-1', {
    channel: '1',
    name: 'Test',
    url: CREDENTIALED_URL,
    internalUrl: 'http://localhost:1234/channel/1'
  }, { retryDelay: 20, maxConsecutiveFailures: 1 })

  await settle(300)
  worker.stream.end()
  await settle(50)

  const log = readLog()
  assert.ok(log.length > 0, 'the logger should have written something to assert on')
  assert.ok(!log.includes(FAKE_PASSWORD), 'the password must never be logged')
  assert.ok(!log.includes(FAKE_USERNAME), 'the username must never be logged')
  assert.ok(log.includes('provider.example'), 'the host is still logged for diagnostics')
})

test('an upstream that fails immediately is retried with a delay, not in a tight loop', async (t) => {
  let attempts = 0
  const server = http.createServer((req, res) => {
    attempts++
    res.socket.destroy()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-2', {
    channel: '2',
    name: 'Flaky',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/2'
  }, { allowPrivateNetwork: true, retryDelay: 30, maxConsecutiveFailures: 3 })

  const ended = new Promise((resolve) => worker.once('end', resolve))
  await ended
  worker.stream.end()
  await settle(120)

  // Bounded: it gave up rather than hammering the provider forever.
  assert.ok(attempts <= 4, `expected at most 4 upstream attempts, saw ${attempts}`)
  assert.ok(worker.failures >= 3, 'failures were counted')
})

test('a worker stops retrying once its stream has ended', async (t) => {
  let attempts = 0
  const server = http.createServer((req, res) => { attempts++; res.socket.destroy() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-3', {
    channel: '3',
    name: 'Gone',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/3'
  }, { allowPrivateNetwork: true, retryDelay: 25, maxConsecutiveFailures: 50 })

  await settle(60)
  worker.stream.end()
  await settle(40)
  const afterEnd = attempts
  await settle(150)
  assert.strictEqual(attempts, afterEnd, 'no further upstream attempts after the stream ended')
  assert.strictEqual(worker.retryTimer, null, 'no retry timer left pending')
})

test('a channel URL pointing at the internal network is refused by the worker', async () => {
  const worker = new Worker('guid-4', {
    channel: '4',
    name: 'SSRF',
    url: 'http://169.254.169.254/latest/meta-data/',
    internalUrl: 'http://localhost:1234/channel/4'
  }, { retryDelay: 20, maxConsecutiveFailures: 1 })

  const ended = new Promise((resolve) => worker.once('end', resolve))
  await ended
  worker.stream.end()
  await settle(50)
  assert.ok(readLog().includes('private network address'), 'the refusal is recorded')
})

test('subscribe and unsubscribe track listeners and end the worker at zero', () => {
  // lingerMs: 0 keeps this focused on the counting. The hold-open behaviour
  // that now applies by default has its own tests below.
  const worker = new Worker('guid-5', {
    channel: '5',
    name: 'Counting',
    url: 'http://provider.example/stream.ts',
    internalUrl: 'http://localhost:1234/channel/5'
  }, { retryDelay: 10000, maxConsecutiveFailures: 1, lingerMs: 0 })

  let ended = 0
  worker.on('end', () => ended++)
  worker.subscribe()
  worker.subscribe()
  assert.strictEqual(worker.listeners, 2)
  worker.unsubscribe()
  assert.strictEqual(ended, 0, 'still one viewer left')
  worker.unsubscribe()
  assert.strictEqual(worker.listeners, 0)
  assert.strictEqual(ended, 1, 'the last viewer leaving ends the worker')
  worker.stream.end()
})

test('a 458 from the provider fails fast instead of retrying', async (t) => {
  let attempts = 0
  const server = http.createServer((req, res) => {
    attempts++
    res.writeHead(458)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-458', {
    channel: '9',
    name: 'TF1 FHD',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/9'
  }, { allowPrivateNetwork: true, retryDelay: 20, maxConsecutiveFailures: 5 })

  const reported = await new Promise((resolve) => {
    worker.once('upstream-error', (status, explanation) => resolve({ status, explanation }))
  })
  worker.stream.end()
  await settle(200)

  assert.strictEqual(reported.status, 458)
  assert.match(reported.explanation, /simultaneous connections/)
  assert.strictEqual(attempts, 1, 'a refusal must not be retried')
})

test('the readable reason reaches the log instead of "Unknown Error"', async (t) => {
  const server = http.createServer((req, res) => { res.writeHead(458); res.end() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-458-log', {
    channel: '10',
    name: 'TF1 FHD',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/10'
  }, { allowPrivateNetwork: true, retryDelay: 20, maxConsecutiveFailures: 5 })

  await new Promise((resolve) => worker.once('upstream-error', resolve))
  worker.stream.end()
  await settle(200)

  const log = readLog()
  assert.ok(log.includes('Cannot play TF1 FHD'), 'the channel name is named in the log')
  assert.ok(log.includes('simultaneous connections'), 'the cause is spelled out')
})

test('a 5xx is still retried, since it is usually transient', async (t) => {
  let attempts = 0
  const server = http.createServer((req, res) => { attempts++; res.writeHead(503); res.end() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-503', {
    channel: '11',
    name: 'Flaky',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/11'
  }, { allowPrivateNetwork: true, retryDelay: 25, maxConsecutiveFailures: 3 })

  await new Promise((resolve) => worker.once('end', resolve))
  worker.stream.end()
  await settle(150)
  assert.ok(attempts > 1, `a 503 should be retried, saw ${attempts} attempt(s)`)
})

test('an Xtream style stream URL is never logged with its credentials', async () => {
  // The path form is what real providers use, and is what leaked before.
  const worker = new Worker('guid-xtream', {
    channel: '12',
    name: 'TF1 FHD',
    url: `http://provider.example/${FAKE_USERNAME}/${FAKE_PASSWORD}/506638.ts`,
    internalUrl: 'http://localhost:1234/channel/12'
  }, { retryDelay: 20, maxConsecutiveFailures: 1 })

  await settle(300)
  worker.stream.end()
  await settle(50)

  const log = readLog()
  assert.ok(!log.includes(FAKE_PASSWORD), 'the password must never be logged')
  assert.ok(!log.includes(FAKE_USERNAME), 'the username must never be logged')
  assert.ok(log.includes('506638'), 'the stream id is still logged')
})

test('issue #30: the upstream is held open briefly so a reconnect does not restart it', async (t) => {
  let connections = 0
  const server = http.createServer((req, res) => {
    connections++
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    const chunk = Buffer.alloc(376, 0x11)
    chunk[0] = 0x47
    chunk[188] = 0x47
    const timer = setInterval(() => res.write(chunk), 40)
    req.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port

  const worker = new Worker('guid-linger', {
    channel: '20',
    name: 'Linger',
    url: `http://127.0.0.1:${port}/stream`,
    internalUrl: 'http://localhost:1234/channel/20'
  }, { allowPrivateNetwork: true, lingerMs: 1500 })

  await settle(200)
  worker.subscribe()
  await settle(200)
  assert.strictEqual(connections, 1, 'one upstream connection')

  // A player that drops and immediately reconnects, which Plex does routinely.
  worker.unsubscribe()
  assert.strictEqual(worker.lingerTimer !== null, true, 'the upstream is held open')
  await settle(300)
  worker.subscribe()
  await settle(300)

  assert.strictEqual(worker.lingerTimer, null, 'the linger was cancelled on reconnect')
  assert.strictEqual(connections, 1, 'the reconnect reused the running upstream')
  assert.strictEqual(worker.listeners, 1)

  worker.unsubscribe()
  worker.stream.end()
  await settle(100)
})

test('the worker does end once the linger expires with nobody watching', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    const chunk = Buffer.alloc(376, 0x11)
    chunk[0] = 0x47
    chunk[188] = 0x47
    const timer = setInterval(() => res.write(chunk), 40)
    req.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const worker = new Worker('guid-linger-expire', {
    channel: '21',
    name: 'Expire',
    url: `http://127.0.0.1:${server.address().port}/stream`,
    internalUrl: 'http://localhost:1234/channel/21'
  }, { allowPrivateNetwork: true, lingerMs: 300 })

  worker.subscribe()
  await settle(200)
  const ended = new Promise((resolve) => worker.once('end', resolve))
  worker.unsubscribe()
  await ended
  assert.strictEqual(worker.listeners, 0)
  worker.stream.end()
  await settle(100)
})

test('lingerMs of zero restores the immediate teardown', () => {
  const worker = new Worker('guid-no-linger', {
    channel: '22',
    name: 'NoLinger',
    url: 'http://provider.example/stream.ts',
    internalUrl: 'http://localhost:1234/channel/22'
  }, { lingerMs: 0, retryDelay: 10000 })

  let ended = 0
  worker.on('end', () => ended++)
  worker.subscribe()
  worker.unsubscribe()
  assert.strictEqual(ended, 1, 'ends straight away when lingering is disabled')
  assert.strictEqual(worker.lingerTimer, null)
  worker.stream.end()
})
