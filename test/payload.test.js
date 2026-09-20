require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { describePayload, detectPayload, looksLikeTransportStream } = require('../payload')

function tsChunk (length) {
  const chunk = Buffer.alloc(length || 400, 0x11)
  chunk[0] = 0x47
  if (chunk.length > 188) chunk[188] = 0x47
  return chunk
}

test('a transport stream is recognised by its sync bytes', () => {
  assert.strictEqual(detectPayload('video/mp2t', tsChunk()), 'mpegts')
  assert.strictEqual(looksLikeTransportStream(tsChunk()), true)
  // A single 0x47 with the next packet boundary wrong is not a transport stream.
  const impostor = Buffer.alloc(400, 0x11)
  impostor[0] = 0x47
  assert.strictEqual(looksLikeTransportStream(impostor), false)
})

test('the body wins over a mislabelled content type', () => {
  // Providers mislabel in both directions.
  assert.strictEqual(detectPayload('text/html', tsChunk()), 'mpegts')
  assert.strictEqual(detectPayload('video/mp2t', Buffer.from('#EXTM3U\n#EXTINF:1,\na.ts')), 'hls')
})

test('an HLS manifest is recognised, with or without a byte order mark', () => {
  assert.strictEqual(detectPayload('application/x-mpegurl', Buffer.from('#EXTM3U\n')), 'hls')
  assert.strictEqual(detectPayload('text/plain', Buffer.from('#EXTM3U\n#EXTINF:1,\na.ts')), 'hls')
  const bom = Buffer.from(String.fromCharCode(0xFEFF) + '#EXTM3U\n')
  assert.strictEqual(detectPayload('text/plain', bom), 'hls')
})

test('a provider error page served with 200 is not mistaken for video', () => {
  // This is what the live provider actually returns when the line is busy.
  assert.strictEqual(detectPayload('text/html; charset=UTF-8', Buffer.from('FAILED TO CONNECT')), 'other')
  assert.strictEqual(detectPayload('text/html', Buffer.from('<html><body>Not authorised</body></html>')), 'other')
})

test('an unrecognised body falls back to the content type', () => {
  const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03])
  assert.strictEqual(detectPayload('video/mp2t', unknown), 'mpegts')
  assert.strictEqual(detectPayload('application/octet-stream', unknown), 'mpegts')
  assert.strictEqual(detectPayload('text/plain', unknown), 'other')
  assert.strictEqual(detectPayload('', unknown), 'other')
})

test('describePayload turns an error page into one readable line', () => {
  assert.match(describePayload('text/html', Buffer.from('FAILED TO CONNECT')), /FAILED TO CONNECT/)
  // HTML tags are stripped so the log stays readable.
  const html = describePayload('text/html', Buffer.from('<html><body>  Line\n banned </body></html>'))
  assert.ok(!html.includes('<body>'))
  assert.match(html, /Line banned/)
  // A long page is truncated rather than dumped into the log.
  const long = describePayload('text/html', Buffer.from('x'.repeat(400)))
  assert.ok(long.length < 250, `expected truncation, got ${long.length} chars`)
})

test('an empty body still produces a message', () => {
  assert.match(describePayload('text/html', Buffer.alloc(0)), /text\/html/)
  assert.match(describePayload('', null), /unknown content type/)
})
