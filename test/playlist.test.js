require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { parsePlaylist } = require('../src/sources/playlist')

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
  assert.strictEqual(channels.length, 1)
  assert.strictEqual(channels[0].channel, '2')
  assert.strictEqual(channels[0].name, 'AMC HD')
  assert.strictEqual(channels[0].url, 'http://cdn.example.com/amc.ts')
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

// --- Regressions reported in the issue tracker ---

const UK_SAMPLE = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="UK",UK: BBC One',
  'http://cdn.example.com/1.ts',
  '#EXTINF:-1 group-title="UK",UK: BBC Two',
  'http://cdn.example.com/2.ts',
  '#EXTINF:-1 group-title="UK",UK: ITV',
  'http://cdn.example.com/3.ts',
  '#EXTINF:-1 group-title="US",US: CNN',
  'http://cdn.example.com/4.ts'
].join('\n')

test('issue #21: a filter matching many channels numbers them consecutively', () => {
  // Every match used to be given the identical number, and Plex keeps one
  // channel per number, so the whole group collapsed to a single entry.
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^UK:', channel: '100' }]
  })
  assert.strictEqual(channels.length, 3)
  assert.deepStrictEqual(channels.map((line) => line.channel), ['100', '101', '102'])
  assert.deepStrictEqual(channels.map((line) => line.name), ['UK: BBC One', 'UK: BBC Two', 'UK: ITV'])
})

test('issue #21: a filter with no channel number auto-numbers instead of "undefined"', () => {
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^UK:' }]
  })
  assert.strictEqual(channels.length, 3)
  for (const line of channels) {
    assert.notStrictEqual(line.channel, 'undefined', 'the literal string "undefined" must never reach Plex')
    assert.ok(Number.isFinite(Number(line.channel)), `${line.channel} should be numeric`)
  }
  assert.deepStrictEqual(channels.map((line) => line.channel), ['80000', '80001', '80002'])
})

test('two filters keep their own numbering runs', () => {
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [
      { name: '^UK:', channel: '100' },
      { name: '^US:', channel: '200' }
    ]
  })
  assert.deepStrictEqual(channels.map((line) => line.channel), ['100', '101', '102', '200'])
})

test('a combined name and meta filter matches, as the README documents', () => {
  // The old guard `if (!nameFilter || !metaFilter)` skipped the whole block
  // when both were supplied, so combined filters never matched anything -
  // including the example shipped in template.json.
  const channels = parsePlaylist(SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{
      name: '^AMC$',
      meta: 'I254\\.59337\\.schedulesdirect\\.org',
      rename: 'AMC HD',
      channel: '2'
    }]
  })
  assert.strictEqual(channels.length, 1)
  assert.strictEqual(channels[0].channel, '2')
  assert.strictEqual(channels[0].name, 'AMC HD')
  assert.strictEqual(channels[0].url, 'http://cdn.example.com/amc.ts')
})

test('a combined filter still rejects a channel matching only one half', () => {
  const channels = parsePlaylist(SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^AMC$', meta: 'does-not-appear-anywhere', channel: '2' }]
  })
  assert.deepStrictEqual(channels, [], 'both halves must match')
})

test('the filter example shipped in template.json actually matches', () => {
  const template = require('../template.json')
  const channels = parsePlaylist(SAMPLE, Object.assign({}, template, { removeIfNotFoundOnFilter: true }))
  const amc = channels.find((line) => line.name === 'AMC')
  assert.ok(amc, 'the template filter should match the AMC entry')
})

test('issue #33: a group can be filtered through the meta pattern alone', () => {
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ meta: 'group-title="UK"', channel: '1' }]
  })
  assert.strictEqual(channels.length, 3, 'every channel in the group is kept')
  assert.deepStrictEqual(channels.map((line) => line.channel), ['1', '2', '3'])
})

test('a filter setting neither name nor meta is ignored, not applied to everything', () => {
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: false,
    filter: [{ channel: '5' }]
  })
  assert.strictEqual(channels.length, 4)
  assert.ok(!channels.every((line) => line.channel === '5'), 'it must not claim every channel')
  assert.deepStrictEqual(channels.map((line) => line.channel), ['80000', '80001', '80002', '80003'])
})

test('rename applies to every channel a filter matches', () => {
  const channels = parsePlaylist(UK_SAMPLE, {
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^UK:', rename: 'British', channel: '10' }]
  })
  assert.deepStrictEqual(channels.map((line) => line.name), ['British', 'British', 'British'])
  assert.deepStrictEqual(channels.map((line) => line.channel), ['10', '11', '12'])
})

test('a filter that matches nothing says so, with the escaped form to copy', () => {
  // Four separate issues in the tracker were a filter silently matching
  // nothing. Reported literally, a "+" is a quantifier, not a plus sign.
  const { escapeHint } = require('../src/sources/playlist')
  const hint = escapeHint('Canal + 1 HD PL')
  assert.match(hint, /regular expressions/)
  assert.match(hint, /Canal/)
  assert.ok(hint.includes('+'), 'the corrected pattern is offered verbatim')
})

test('no escaping hint is offered for a pattern that has nothing to escape', () => {
  const { escapeHint } = require('../src/sources/playlist')
  assert.strictEqual(escapeHint('BBC One HD'), '')
  assert.strictEqual(escapeHint(undefined), '')
  assert.strictEqual(escapeHint(123), '')
})

test('a plus sign in a channel name survives parsing untouched', () => {
  // Verified against the reports: the tuner handles "+" correctly. What fails
  // is a filter typed literally.
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="CanalPlus1.pl" tvg-logo="http://x/a.png",Canal + 1 HD PL',
    'http://cdn.example.com/1.ts',
    '#EXTINF:-1,Canal+',
    'http://cdn.example.com/2.ts',
    ''
  ].join('\n')
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false })
  assert.deepStrictEqual(channels.map((line) => line.name), ['Canal + 1 HD PL', 'Canal+'])
})

test('an escaped plus matches the channel it names', () => {
  const playlist = ['#EXTM3U', '#EXTINF:-1,Canal + 1 HD PL', 'http://cdn.example.com/1.ts', ''].join('\n')
  const literal = parsePlaylist(playlist, { removeIfNotFoundOnFilter: true, filter: [{ name: 'Canal + 1 HD PL', channel: '1' }] })
  assert.deepStrictEqual(literal, [], 'typed literally it matches nothing, which is the trap')

  const escaped = parsePlaylist(playlist, { removeIfNotFoundOnFilter: true, filter: [{ name: 'Canal \\+ 1 HD PL', channel: '1' }] })
  assert.deepStrictEqual(escaped.map((line) => line.name), ['Canal + 1 HD PL'])
})

test('a comma inside group-title does not swallow the channel name', () => {
  // Attribute values may contain commas; the name is what follows the last one.
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-logo="http://x/b.png" group-title="MOVIE, HBO",HBO',
    'http://cdn.example.com/2.ts',
    ''
  ].join('\n')
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false })
  assert.deepStrictEqual(channels.map((line) => line.name), ['HBO'])
})
