require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const Preloader = require('../src/stream/preloader')

function line (url) {
  return { channel: '1', name: 'Test', url, internalUrl: 'http://localhost:1234/channel/1' }
}

test('the same URL reuses one worker so a channel is pulled once', () => {
  const preloader = new Preloader()
  const first = preloader.preload(line('http://cdn.example.com/a.ts'))
  const second = preloader.preload(line('http://cdn.example.com/a.ts'))
  assert.strictEqual(first, second)
  assert.strictEqual(preloader.workers.size, 1)
  first.stream.end()
})

test('different URLs get their own worker', () => {
  const preloader = new Preloader()
  const a = preloader.preload(line('http://cdn.example.com/a.ts'))
  const b = preloader.preload(line('http://cdn.example.com/b.ts'))
  assert.notStrictEqual(a, b)
  assert.strictEqual(preloader.workers.size, 2)
  a.stream.end()
  b.stream.end()
})

test('a finished worker is removed from the registry', () => {
  const preloader = new Preloader()
  const worker = preloader.preload(line('http://cdn.example.com/a.ts'))
  assert.strictEqual(preloader.workers.size, 1)
  worker.emit('end', worker.guid)
  assert.strictEqual(preloader.workers.size, 0)
  worker.stream.end()
})

test('the worker registry is a Map, so lookups cannot reach Object.prototype', () => {
  const preloader = new Preloader()
  assert.ok(preloader.workers instanceof Map)
  // The previous implementation indexed a plain object with a computed lodash
  // path, which is the classic prototype pollution shape.
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
    assert.strictEqual(preloader.workers.get(key), undefined)
    preloader.removeWorker(key)
  }
  assert.strictEqual({}.polluted, undefined)
  assert.strictEqual(typeof {}.toString, 'function', 'Object.prototype still intact')
})

test('removing a worker that was never registered is a no-op', () => {
  const preloader = new Preloader()
  assert.doesNotThrow(() => preloader.removeWorker('nope'))
  assert.strictEqual(preloader.workers.size, 0)
})

test('preload hands its options to the worker it creates', () => {
  const preloader = new Preloader()
  const worker = preloader.preload(line('http://192.168.1.9/a.ts'), { allowPrivateNetwork: true, retryDelay: 10000 })
  assert.strictEqual(worker.options.allowPrivateNetwork, true)
  worker.stream.end()
})
