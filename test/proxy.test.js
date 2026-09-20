require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const Server = require('../index')

function fakeReq (channelId) {
  const req = new EventEmitter()
  req.params = { channelId }
  req.protocol = 'http'
  req.get = () => 'localhost:1234'
  return req
}

/**
 * Stands in for an http.ServerResponse. `stall` models a client that never
 * drains its socket, so writableLength only grows - which is the condition the
 * proxy has to survive without buffering without limit.
 */
function fakeRes (options) {
  const settings = options || {}
  const res = new EventEmitter()
  return Object.assign(res, {
    statusCode: 200,
    body: '',
    written: [],
    headers: {},
    ended: false,
    writableEnded: false,
    destroyed: false,
    headersSent: false,
    writableLength: 0,
    status (code) { this.statusCode = code; return this },
    type (value) { this.headers['Content-Type'] = value; return this },
    setHeader (name, value) { this.headers[name] = value },
    send (payload) {
      this.body = payload
      this.ended = true
      this.writableEnded = true
      this.headersSent = true
      return this
    },
    write (chunk) {
      this.written.push(chunk)
      this.headersSent = true
      if (settings.stall) this.writableLength = this.writableLength + chunk.length
      return this.writableLength === 0
    },
    end () {
      this.ended = true
      this.writableEnded = true
      this.headersSent = true
    },
    destroy () {
      this.destroyed = true
      this.emit('close')
    }
  })
}

function fakeWorker () {
  const worker = new EventEmitter()
  worker.stream = new EventEmitter()
  worker.subscribed = 0
  worker.subscribe = () => { worker.subscribed++ }
  worker.unsubscribe = () => { worker.subscribed-- }
  return worker
}

function makeServer (channels) {
  const server = new Server()
  server.channels = channels || []
  server.settings = {}
  return server
}

test('an unknown channel id answers 404 instead of faulting', () => {
  const server = makeServer([{ channel: '1', name: 'A', url: 'http://cdn.example.com/a.ts' }])
  const res = fakeRes()
  // Before the fix the handler assigned to `line.internalUrl` before checking
  // whether `line` existed, so any unknown id threw a TypeError.
  assert.doesNotThrow(() => server.proxy(fakeReq('does-not-exist'), res))
  assert.strictEqual(res.statusCode, 404)
  assert.strictEqual(res.body, 'channel id not found')
})

test('unknown channel ids of every shape are handled', () => {
  const server = makeServer([{ channel: '1', name: 'A', url: 'http://cdn.example.com/a.ts' }])
  for (const id of ['', '0', '../../etc/passwd', '__proto__', 'constructor', '1 ', 'NaN', '%00']) {
    const res = fakeRes()
    assert.doesNotThrow(() => server.proxy(fakeReq(id), res), `id ${JSON.stringify(id)} must not throw`)
    assert.strictEqual(res.statusCode, 404, `id ${JSON.stringify(id)} must be rejected`)
  }
})

test('a prototype polluting channel id does not resolve to a channel', () => {
  const server = makeServer([{ channel: '1', name: 'A', url: 'http://cdn.example.com/a.ts' }])
  const res = fakeRes()
  server.proxy(fakeReq('__proto__'), res)
  assert.strictEqual(res.statusCode, 404)
  assert.strictEqual({}.internalUrl, undefined, 'Object.prototype must be untouched')
})

test('a known channel is streamed from its worker', async () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = new EventEmitter()
  worker.stream = new EventEmitter()
  worker.subscribed = 0
  worker.subscribe = () => { worker.subscribed++ }
  worker.unsubscribe = () => { worker.subscribed-- }
  server.preloader.preload = () => worker

  const res = fakeRes()
  server.proxy(fakeReq('7'), res)
  assert.strictEqual(worker.subscribed, 1)

  worker.emit('data', Buffer.from('abc'))
  worker.emit('end')
  assert.deepStrictEqual(res.written.map(String), ['abc'])
  assert.strictEqual(res.ended, true)
})

test('closing the client connection unsubscribes and detaches listeners', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = new EventEmitter()
  worker.stream = new EventEmitter()
  worker.subscribed = 0
  worker.subscribe = () => { worker.subscribed++ }
  worker.unsubscribe = () => { worker.subscribed-- }
  server.preloader.preload = () => worker

  const req = fakeReq('7')
  const res = fakeRes()
  server.proxy(req, res)
  assert.strictEqual(worker.listenerCount('data'), 1)

  req.emit('close')
  assert.strictEqual(worker.subscribed, 0, 'the worker must be released')
  assert.strictEqual(worker.listenerCount('data'), 0, 'no listener left leaking per request')
  assert.strictEqual(worker.listenerCount('end'), 0)

  // Data arriving after the client left must not be written to a dead response.
  worker.emit('data', Buffer.from('late'))
  assert.deepStrictEqual(res.written, [])
})

test('many sequential requests do not accumulate listeners on a shared worker', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = new EventEmitter()
  worker.stream = new EventEmitter()
  worker.subscribe = () => {}
  worker.unsubscribe = () => {}
  server.preloader.preload = () => worker

  for (let i = 0; i < 50; i++) {
    const req = fakeReq('7')
    server.proxy(req, fakeRes())
    req.emit('close')
  }
  assert.strictEqual(worker.listenerCount('data'), 0)
  assert.strictEqual(worker.listenerCount('end'), 0)
})

test('the allowPrivateNetwork opt in is passed through to the worker', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://192.168.1.9/7.ts' }])
  server.settings = { allowPrivateNetwork: true }
  let seen = null
  server.preloader.preload = (line, options) => {
    seen = options
    const worker = new EventEmitter()
    worker.stream = new EventEmitter()
    worker.subscribe = () => {}
    worker.unsubscribe = () => {}
    return worker
  }
  server.proxy(fakeReq('7'), fakeRes())
  assert.ok(seen, 'preload must receive options')
  assert.strictEqual(seen.allowPrivateNetwork, true)
})

test('allowPrivateNetwork defaults to false when the setting is absent', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  server.settings = {}
  let seen = null
  server.preloader.preload = (line, options) => {
    seen = options
    const worker = new EventEmitter()
    worker.stream = new EventEmitter()
    worker.subscribe = () => {}
    worker.unsubscribe = () => {}
    return worker
  }
  server.proxy(fakeReq('7'), fakeRes())
  assert.strictEqual(seen.allowPrivateNetwork, false)
})

test('a stalled viewer has its frames dropped instead of buffered without limit', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  // stall: the socket never drains, so writableLength only grows.
  const res = fakeRes({ stall: true })
  server.proxy(fakeReq('7'), res)

  const chunk = Buffer.alloc(64 * 1024)
  for (let i = 0; i < 400; i++) worker.emit('data', chunk)

  // 8MB cap / 64KB chunks = 128 writes before dropping starts.
  assert.ok(res.written.length < 400, 'the proxy must stop writing once the client falls behind')
  assert.ok(res.writableLength <= 9 * 1024 * 1024, `queue stayed bounded, was ${res.writableLength}`)
  assert.ok(res.written.length >= 100, 'it should still have written while there was room')
})

test('a viewer that never catches up is disconnected rather than held forever', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const res = fakeRes({ stall: true })
  server.proxy(fakeReq('7'), res)

  const chunk = Buffer.alloc(64 * 1024)
  for (let i = 0; i < 1200; i++) worker.emit('data', chunk)

  assert.strictEqual(res.destroyed, true, 'the hopeless viewer is disconnected')
  assert.strictEqual(worker.subscribed, 0, 'and its subscription is released')
  assert.strictEqual(worker.listenerCount('data'), 0, 'and its listeners are gone')
})

test('a viewer that keeps up is never dropped', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const res = fakeRes() // drains immediately: writableLength stays 0
  server.proxy(fakeReq('7'), res)

  const chunk = Buffer.alloc(64 * 1024)
  for (let i = 0; i < 1000; i++) worker.emit('data', chunk)

  assert.strictEqual(res.written.length, 1000, 'every chunk reached a healthy client')
  assert.strictEqual(res.destroyed, false)
})

test('releasing twice only unsubscribes once', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const req = fakeReq('7')
  const res = fakeRes()
  server.proxy(req, res)
  assert.strictEqual(worker.subscribed, 1)

  // The worker ending and the client leaving both release; either can be first.
  worker.emit('end')
  req.emit('close')
  res.emit('close')

  assert.strictEqual(worker.subscribed, 0, 'exactly one unsubscribe, not three')
})

test('the stream carries a transport-stream content type', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const res = fakeRes()
  server.proxy(fakeReq('7'), res)
  worker.emit('data', Buffer.from('abc'))

  assert.strictEqual(res.headers['Content-Type'], 'video/mp2t')
  assert.strictEqual(res.headers['Cache-Control'], 'no-store')
})

test('a refusal after bytes were already sent does not try to rewrite the status', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const res = fakeRes()
  server.proxy(fakeReq('7'), res)
  worker.emit('data', Buffer.from('abc'))
  assert.doesNotThrow(() => worker.emit('upstream-error', 458, 'connection limit'))
  assert.strictEqual(res.statusCode, 200, 'headers were already sent, so 200 stands')
})

test('many concurrent viewers of one channel do not trip the listener warning', () => {
  const server = makeServer([{ channel: '7', name: 'Seven', url: 'http://cdn.example.com/7.ts' }])
  const worker = fakeWorker()
  server.preloader.preload = () => worker

  const warnings = []
  const onWarning = (w) => warnings.push(w)
  process.on('warning', onWarning)

  const viewers = []
  for (let i = 0; i < 40; i++) {
    const req = fakeReq('7')
    const res = fakeRes()
    server.proxy(req, res)
    viewers.push({ req, res })
  }
  assert.strictEqual(worker.subscribed, 40)
  assert.strictEqual(worker.listenerCount('data'), 40)

  for (const v of viewers) v.req.emit('close')
  assert.strictEqual(worker.listenerCount('data'), 0, 'all listeners released')
  assert.strictEqual(worker.subscribed, 0)

  process.removeListener('warning', onWarning)
  assert.deepStrictEqual(warnings.filter((w) => /MaxListeners/.test(w.name || '')), [])
})
