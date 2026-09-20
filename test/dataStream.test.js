require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const DataStream = require('../dataStream')

test('written chunks are emitted on the next tick', async () => {
  const stream = new DataStream()
  const received = []
  stream.on('data', (chunk) => received.push(chunk.toString()))
  stream.write(Buffer.from('a'))
  stream.write(Buffer.from('b'))
  await new Promise((resolve) => stream.once('empty', resolve))
  assert.deepStrictEqual(received, ['a', 'b'])
  stream.end()
})

test('the queue is bounded so a stalled consumer cannot exhaust memory', () => {
  const stream = new DataStream({ maxBufferedBytes: 1024 })
  let overflows = 0
  stream.on('overflow', () => overflows++)

  assert.strictEqual(stream.write(Buffer.alloc(512)), true)
  assert.strictEqual(stream.write(Buffer.alloc(512)), true)
  // The queue is full: further writes are dropped rather than queued.
  assert.strictEqual(stream.write(Buffer.alloc(512)), false)
  assert.strictEqual(stream.write(Buffer.alloc(512)), false)

  assert.strictEqual(overflows, 2)
  assert.strictEqual(stream.droppedChunks, 2)
  assert.ok(stream._bufferedBytes <= 1024, 'buffered bytes stay within the cap')
  stream.end()
})

test('the queue drains and accepts writes again after a tick', async () => {
  const stream = new DataStream({ maxBufferedBytes: 1024 })
  stream.on('data', () => {})
  stream.write(Buffer.alloc(1024))
  assert.strictEqual(stream.write(Buffer.alloc(1)), false)
  await new Promise((resolve) => stream.once('empty', resolve))
  assert.strictEqual(stream._bufferedBytes, 0)
  assert.strictEqual(stream.write(Buffer.alloc(1)), true)
  stream.end()
})

test('end stops the ticker and releases the queue', async () => {
  const stream = new DataStream()
  stream.write(Buffer.alloc(16))
  stream.end()
  await new Promise((resolve) => stream.once('end', resolve))
  assert.strictEqual(stream.isEnded, true)
  assert.strictEqual(stream.timer, null, 'no timer left keeping the loop alive')
  assert.strictEqual(stream._bufferedBytes, 0)
  assert.strictEqual(stream.write(Buffer.alloc(16)), false, 'writes after end are refused')
})

test('end is idempotent', async () => {
  const stream = new DataStream()
  let ends = 0
  stream.on('end', () => ends++)
  stream.end()
  stream.end()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.strictEqual(ends, 1)
})
