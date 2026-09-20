require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const NEWLINE = String.fromCharCode(10)
const { buildChannelElements, buildIdMap, extractProgrammes, guessEpgUrl, remapProgramme } = require('../xmltv')
const { parseAttributes, parsePlaylist, usableLogo } = require('../playlist')

test('tvg attributes are read, including the spaced form providers use', () => {
  const spaced = parseAttributes(' -1 tvg-id = "Hbo" tvg-name = "HBO" tvg-logo = "https://i.imgur.com/x.png"')
  assert.strictEqual(spaced['tvg-id'], 'Hbo')
  assert.strictEqual(spaced['tvg-logo'], 'https://i.imgur.com/x.png')

  const tight = parseAttributes('-1 tvg-id="a" tvg-logo="http://x/y.png" group-title="News"')
  assert.strictEqual(tight['group-title'], 'News')
  assert.deepStrictEqual(parseAttributes(''), {})
  assert.deepStrictEqual(parseAttributes(undefined), {})
})

test('a logo URL from the playlist is only passed on when it is plain http', () => {
  // The playlist is untrusted and Plex is the one that loads this URL.
  assert.strictEqual(usableLogo('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png')
  assert.strictEqual(usableLogo('javascript:alert(1)'), '')
  assert.strictEqual(usableLogo('data:image/png;base64,AAA'), '')
  assert.strictEqual(usableLogo('file:///etc/passwd'), '')
  assert.strictEqual(usableLogo('not a url'), '')
  assert.strictEqual(usableLogo(''), '')
  assert.strictEqual(usableLogo(undefined), '')
})

test('channels carry their logo through parsing', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="hbo" tvg-logo="https://cdn.example.com/hbo.png",HBO',
    'http://cdn.example.com/1.ts',
    '#EXTINF:-1,No Logo',
    'http://cdn.example.com/2.ts',
    ''
  ].join('\n')
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false })
  assert.strictEqual(channels[0].logo, 'https://cdn.example.com/hbo.png')
  assert.strictEqual(channels[0].tvgId, 'hbo')
  assert.strictEqual(channels[1].logo, '', 'a channel without one is empty, not undefined')
})

test('the guide lists every channel, with an icon only where there is one', () => {
  const xml = buildChannelElements([
    { channel: '1', name: 'HBO', logo: 'https://cdn.example.com/hbo.png', tvgId: 'hbo' },
    { channel: '2', name: 'No Logo', logo: '', tvgId: '' }
  ])
  assert.match(xml, /<channel id="1">/)
  assert.match(xml, /<icon src="https:\/\/cdn\.example\.com\/hbo\.png" \/>/)
  assert.match(xml, /<channel id="2">/)
  assert.strictEqual(xml.match(/<icon/g).length, 1, 'no empty icon element for the channel without one')
})

test('a hostile channel name or logo cannot break out of the guide', () => {
  const xml = buildChannelElements([
    { channel: '1', name: '</display-name><script>alert(1)</script><display-name>', logo: 'https://x/a.png?a=1&b=2', tvgId: '' }
  ])
  assert.ok(!xml.includes('<script>'))
  assert.match(xml, /&lt;script&gt;/)
  assert.match(xml, /a=1&amp;b=2/, 'an ampersand in a logo URL is escaped')
})

test('provider channel ids are rewritten to the numbers Plex was given', () => {
  // After filtering and renaming, the provider's ids no longer line up, which
  // is exactly why pointing Plex at the raw provider guide stops working.
  const idMap = buildIdMap([
    { channel: '101', name: 'BBC One', tvgId: 'bbcone.uk' },
    { channel: '102', name: 'BBC Two', tvgId: 'bbctwo.uk' }
  ])
  const programme = '<programme start="20260920120000 +0000" channel="bbcone.uk"><title>News</title></programme>'
  assert.match(remapProgramme(programme, idMap), /channel="101"/)
})

test('a programme for a channel the lineup does not carry is dropped', () => {
  // Keeping them would mean serving a provider's entire catalogue, which runs
  // to tens of megabytes for a lineup that needs a fraction of a percent.
  const idMap = buildIdMap([{ channel: '101', name: 'BBC One', tvgId: 'bbcone.uk' }])
  assert.strictEqual(remapProgramme('<programme channel="not-carried"><title>x</title></programme>', idMap), null)
  assert.strictEqual(remapProgramme('<programme><title>no channel</title></programme>', idMap), null)
})

test('programmes are found by element boundary, not by line', () => {
  // Real guides put newlines inside descriptions and pack several programmes
  // onto one line. Anything line-oriented cuts through the middle of an
  // element and produces XML that will not parse.
  const feed = [
    '<programme start="1" channel="a"><desc>line one',
    'line two inside the same element</desc></programme><programme start="2" channel="b"><title>x</title></programme>',
    '<programme start="3" channel="c"><title>incomplete'
  ].join(NEWLINE)

  const found = extractProgrammes(feed)
  assert.strictEqual(found.programmes.length, 2, 'both complete elements are found')
  assert.ok(found.programmes[0].includes('line two inside the same element'), 'the embedded newline is preserved')
  assert.ok(found.rest.startsWith('<programme start="3"'), 'the incomplete one is held for the next chunk, with the junk before it dropped')
})

test('an element split across chunks is reassembled', () => {
  const first = extractProgrammes('<programme start="1" channel="a"><title>Sp')
  assert.deepStrictEqual(first.programmes, [])
  const second = extractProgrammes(first.rest + 'lit</title></programme>')
  assert.strictEqual(second.programmes.length, 1)
  assert.ok(second.programmes[0].includes('<title>Split</title>'))
  assert.strictEqual(second.rest, '')
})

test('the guide this produces is well formed XML', () => {
  // The first attempt filtered by line and produced a document that would not
  // parse, which is worse than having no guide at all.
  const channels = [
    { channel: '101', name: 'BBC One & Two <HD>', logo: 'https://x/a.png?a=1&b=2', tvgId: 'bbcone.uk' },
    { channel: '102', name: 'No Logo', logo: '', tvgId: 'bbctwo.uk' }
  ]
  const idMap = buildIdMap(channels)
  const feed = '<programme start="1" channel="bbcone.uk"><desc>with' + NEWLINE + 'newline</desc></programme>'
  const body = extractProgrammes(feed).programmes
    .map((p) => remapProgramme(p, idMap))
    .filter(Boolean)
    .join(NEWLINE)

  const document = '<?xml version="1.0" encoding="UTF-8" ?>' + NEWLINE + '<tv>' + NEWLINE +
    buildChannelElements(channels) + NEWLINE + body + NEWLINE + '</tv>' + NEWLINE

  // Node has no XML parser built in, so assert the structure that matters.
  assert.strictEqual((document.match(/<channel /g) || []).length, 2)
  assert.strictEqual((document.match(/<\/channel>/g) || []).length, 2)
  assert.strictEqual((document.match(/<programme/g) || []).length, 1)
  assert.strictEqual((document.match(/<\/programme>/g) || []).length, 1)
  assert.ok(!document.includes('<HD>'), 'the channel name is escaped')
  assert.match(document, /channel="101"/)
})

test('the guide URL is derived from an Xtream playlist URL', () => {
  assert.strictEqual(
    guessEpgUrl('http://line.example/get.php?username=u1234&password=p5678&type=m3u_plus&output=ts'),
    'http://line.example/xmltv.php?username=u1234&password=p5678'
  )
})

test('a playlist that is not Xtream derives no guide URL, rather than guessing', () => {
  assert.strictEqual(guessEpgUrl('https://example.com/playlist.m3u8'), '')
  assert.strictEqual(guessEpgUrl('http://line.example/get.php?type=m3u_plus'), '', 'no credentials, no guess')
  assert.strictEqual(guessEpgUrl('not a url'), '')
  assert.strictEqual(guessEpgUrl(''), '')
  assert.strictEqual(guessEpgUrl(undefined), '')
})

test('the buffer does not grow on text that will never be a programme', () => {
  // A provider guide carries a lot that is not a programme. Holding it all
  // between chunks would grow the buffer for nothing.
  const junk = 'x'.repeat(100000)
  const found = extractProgrammes(junk)
  assert.deepStrictEqual(found.programmes, [])
  assert.ok(found.rest.length < 50, `kept ${found.rest.length} bytes of nothing`)
})

test('a partial opening tag split across chunks is still caught', () => {
  const first = extractProgrammes('some preamble <progr')
  const second = extractProgrammes(first.rest + 'amme start="1" channel="a"><title>x</title></programme>')
  assert.strictEqual(second.programmes.length, 1, 'the split tag was reassembled')
})
