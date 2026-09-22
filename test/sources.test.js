require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const Sources = require('../src/sources/sources')

const LOCAL = { allowPrivateNetwork: true }

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function playlist (names) {
  const lines = ['#EXTM3U']
  for (const name of names) {
    lines.push(`#EXTINF:-1 tvg-name="${name}",${name}`)
    lines.push(`http://cdn.example.com/${name}.ts`)
  }
  return lines.join('\n') + '\n'
}

test('the sources list is read, and an entry with credentials is taken as xtream', () => {
  const found = Sources.describeSources({
    sources: [
      { url: 'http://a.example.com', username: 'user1234', password: 'pass5678' },
      { type: 'm3u', url: 'http://b.example.com/list.m3u8' }
    ]
  })
  assert.strictEqual(found.length, 2)
  assert.strictEqual(found[0].type, 'xtream')
  assert.strictEqual(found[1].type, 'm3u')
})

test('an incomplete entry is skipped rather than half loaded', () => {
  const found = Sources.describeSources({
    sources: [
      { type: 'xtream', url: 'http://a.example.com', username: 'user1234' },
      { type: 'm3u' },
      null,
      { type: 'm3u', url: 'http://good.example.com/list.m3u8' }
    ]
  })
  assert.deepStrictEqual(found.map((source) => source.url), ['http://good.example.com/list.m3u8'])
})

test('the older single source settings still work', () => {
  // Anyone upgrading has one of these, and neither should stop working.
  const xtream = Sources.describeSources({
    xtream: { url: 'http://line.example.org', username: 'user1234', password: 'pass5678' }
  })
  assert.strictEqual(xtream.length, 1)
  assert.strictEqual(xtream[0].type, 'xtream')

  const m3u = Sources.describeSources({ m3u8: { remote: 'http://host.example.com/get.php' } })
  assert.strictEqual(m3u.length, 1)
  assert.strictEqual(m3u[0].type, 'm3u')

  assert.deepStrictEqual(Sources.describeSources({}), [])
  assert.deepStrictEqual(Sources.describeSources(null), [])
})

test('the sources list takes precedence over the older settings', () => {
  const found = Sources.describeSources({
    sources: [{ type: 'm3u', url: 'http://new.example.com/list.m3u8' }],
    m3u8: { remote: 'http://old.example.com/list.m3u8' }
  })
  assert.deepStrictEqual(found.map((source) => source.url), ['http://new.example.com/list.m3u8'])
})

test('merging keeps one header and every channel', () => {
  const merged = Sources.merge([playlist(['One', 'Two']), playlist(['Three'])])
  assert.strictEqual((merged.match(/#EXTM3U/g) || []).length, 1, 'exactly one header')
  assert.strictEqual((merged.match(/#EXTINF/g) || []).length, 3, 'every channel survived')
  for (const name of ['One', 'Two', 'Three']) assert.match(merged, new RegExp(name))
})

test('credentials from every source are collected so the log can scrub them', () => {
  const secrets = Sources.secrets({
    sources: [
      { type: 'xtream', url: 'http://a.example.com', username: 'user1234', password: 'pass5678' },
      { type: 'xtream', url: 'http://b.example.com', username: 'user9876', password: 'pass5432' }
    ]
  })
  for (const value of ['user1234', 'pass5678', 'user9876', 'pass5432']) {
    assert.ok(secrets.includes(value), `${value} is scrubbed`)
  }
})

test('an explicit guide URL wins, otherwise each source brings its own', () => {
  assert.deepStrictEqual(
    Sources.epgUrls({ epgUrl: 'http://guide.example.com/xmltv', sources: [{ type: 'm3u', url: 'http://a.example.com/l.m3u8', epgUrl: 'http://ignored.example.com' }] }),
    ['http://guide.example.com/xmltv']
  )
  assert.deepStrictEqual(
    Sources.epgUrls({ sources: [{ type: 'm3u', url: 'http://a.example.com/l.m3u8', epgUrl: 'http://one.example.com/xmltv' }] }),
    ['http://one.example.com/xmltv']
  )
})

test('two playlists are loaded and merged into one lineup', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
    res.end(req.url === '/a.m3u8' ? playlist(['Alpha']) : playlist(['Beta', 'Gamma']))
  })
  t.after(() => server.close())

  const result = await Sources.loadAll({
    sources: [
      { type: 'm3u', name: 'A', url: `http://127.0.0.1:${port}/a.m3u8` },
      { type: 'm3u', name: 'B', url: `http://127.0.0.1:${port}/b.m3u8` }
    ]
  }, LOCAL)

  assert.deepStrictEqual(result.loaded, ['A', 'B'])
  assert.deepStrictEqual(result.failed, [])
  assert.strictEqual((result.body.match(/#EXTINF/g) || []).length, 3)
})

test('one provider being down does not cost you the others', async (t) => {
  const { server, port } = await listen((req, res) => {
    if (req.url === '/down.m3u8') {
      res.writeHead(500)
      return res.end('nope')
    }
    res.writeHead(200, { 'Content-Type': 'application/x-mpegurl' })
    res.end(playlist(['Alpha']))
  })
  t.after(() => server.close())

  const result = await Sources.loadAll({
    sources: [
      { type: 'm3u', name: 'Down', url: `http://127.0.0.1:${port}/down.m3u8` },
      { type: 'm3u', name: 'Up', url: `http://127.0.0.1:${port}/up.m3u8` }
    ]
  }, LOCAL)

  assert.deepStrictEqual(result.loaded, ['Up'])
  assert.deepStrictEqual(result.failed, ['Down'])
  assert.strictEqual((result.body.match(/#EXTINF/g) || []).length, 1)
})

test('every source failing rejects, so the caller can fall back to the cache', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  t.after(() => server.close())

  await assert.rejects(
    () => Sources.loadAll({
      sources: [
        { type: 'm3u', name: 'One', url: `http://127.0.0.1:${port}/a.m3u8` },
        { type: 'm3u', name: 'Two', url: `http://127.0.0.1:${port}/b.m3u8` }
      ]
    }, LOCAL),
    /none of the 2 configured sources/
  )
})

test('no source at all is reported as configuration, not as a failed fetch', async () => {
  await assert.rejects(() => Sources.loadAll({}, LOCAL), /No playlist or Xtream account is configured/)
})

test('a source is named without ever naming its credentials', () => {
  const name = Sources.describe({ type: 'xtream', url: 'http://line.example.org:8080', username: 'user1234', password: 'pass5678' }, 0)
  assert.ok(!name.includes('user1234'), 'no username')
  assert.ok(!name.includes('pass5678'), 'no password')
  assert.strictEqual(Sources.describe({ type: 'm3u', name: 'My provider', url: 'http://a.example.com' }, 0), 'My provider')
})
