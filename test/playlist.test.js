require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { parsePlaylist } = require('../playlist')

const SAMPLE = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="news.us" group-title="News",>>> US News',
  'http://cdn.example.com/news.ts',
  '#EXTINF:-1 tvg-id="I254.59337.schedulesdirect.org",AMC',
  'http://cdn.example.com/amc.ts',
  '#EXTINF:-1 tvg-id="sports.us",Sports HD',
  'http://cdn.example.com/sports.ts'
].join('\n')

test('parses every entry with a usable URL', () => {
  const channels = parsePlaylist(SAMPLE, { removeIfNotFoundOnFilter: false })
  assert.strictEqual(channels.length, 3)
  assert.deepStrictEqual(channels.map((line) => line.name), ['>>> US News', 'AMC', 'Sports HD'])
  assert.ok(channels.every((line) => line.url.startsWith('http://cdn.example.com/')))
})

test('drops entries whose URL uses a protocol the proxy will not fetch', () => {
  const hostile = [
    '#EXTINF:-1,Local File',
    'file:///etc/passwd',
    '#EXTINF:-1,Script',
    'javascript:alert(1)',
    '#EXTINF:-1,Data',
    'data:text/plain;base64,aGVsbG8=',
    '#EXTINF:-1,Legit',
    'https://cdn.example.com/ok.ts'
  ].join('\n')
  const channels = parsePlaylist(hostile, { removeIfNotFoundOnFilter: false })
  assert.deepStrictEqual(channels.map((line) => line.name), ['Legit'])
})

test('drops entries pointing at the internal network', () => {
  const ssrf = [
    '#EXTINF:-1,Metadata',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    '#EXTINF:-1,Router',
    'http://192.168.1.1/admin',
    '#EXTINF:-1,Loopback',
    'http://127.0.0.1:8080/secret',
    '#EXTINF:-1,Legit',
    'https://cdn.example.com/ok.ts'
  ].join('\n')
  const channels = parsePlaylist(ssrf, { removeIfNotFoundOnFilter: false })
  assert.deepStrictEqual(channels.map((line) => line.name), ['Legit'])
})

test('keeps internal addresses when the operator opts in', () => {
  const lan = [
    '#EXTINF:-1,LAN Tuner',
    'http://192.168.1.50:8080/stream',
    ''
  ].join('\n')
  assert.strictEqual(parsePlaylist(lan, { removeIfNotFoundOnFilter: false }).length, 0)
  const opted = parsePlaylist(lan, { removeIfNotFoundOnFilter: false, allowPrivateNetwork: true })
  assert.strictEqual(opted.length, 1)
  assert.strictEqual(opted[0].name, 'LAN Tuner')
})

test('applies name filters, renaming and channel numbers', () => {
  const channels = parsePlaylist(SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^AMC$', rename: 'AMC HD', channel: '2' }]
  })
  assert.deepStrictEqual(channels, [{ channel: '2', name: 'AMC HD', url: 'http://cdn.example.com/amc.ts' }])
})

test('applies meta filters', () => {
  const channels = parsePlaylist(SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ meta: 'I254\\.59337\\.schedulesdirect\\.org', rename: 'AMC', channel: '3' }]
  })
  assert.deepStrictEqual(channels.map((line) => line.channel), ['3'])
})

test('keeps unmatched channels when removeIfNotFoundOnFilter is off', () => {
  const channels = parsePlaylist(SAMPLE, {
    removeIfNotFoundOnFilter: false,
    filter: [{ name: '^AMC$', channel: '2' }]
  })
  assert.strictEqual(channels.length, 3)
  assert.strictEqual(channels[0].channel, '2', 'filtered channel sorts first')
})

test('honours the channel limit', () => {
  const channels = parsePlaylist(SAMPLE, { removeIfNotFoundOnFilter: false, limit: 2 })
  assert.strictEqual(channels.length, 2)
})

test('an invalid filter regular expression is ignored instead of crashing', () => {
  assert.doesNotThrow(() => {
    const channels = parsePlaylist(SAMPLE, {
      removeIfNotFoundOnFilter: false,
      filter: [{ name: '([unclosed', channel: '9' }]
    })
    assert.strictEqual(channels.length, 3)
  })
})

test('a settings object with no filter array is handled', () => {
  assert.doesNotThrow(() => parsePlaylist(SAMPLE, {}))
  assert.doesNotThrow(() => parsePlaylist(SAMPLE, { filter: 'not-an-array' }))
  assert.doesNotThrow(() => parsePlaylist('', {}))
})

test('channels are ordered numerically, not lexicographically', () => {
  const many = []
  for (let i = 0; i < 12; i++) {
    many.push(`#EXTINF:-1,Channel ${i}`)
    many.push(`http://cdn.example.com/${i}.ts`)
  }
  const channels = parsePlaylist(many.join('\n'), { removeIfNotFoundOnFilter: false })
  const numbers = channels.map((line) => Number(line.channel))
  assert.deepStrictEqual(numbers, numbers.slice().sort((a, b) => a - b))
})
