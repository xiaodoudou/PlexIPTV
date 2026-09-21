require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const Xtream = require('../xtream')
const { parsePlaylist } = require('../playlist')

const LOCAL = { allowPrivateNetwork: true }
const NEWLINE = String.fromCharCode(10)

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/**
 * A stand in for an Xtream panel. `overrides` replaces any of the three
 * responses so a test can make one of them misbehave.
 */
function panel (overrides) {
  const settings = overrides || {}
  return listen((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const action = url.searchParams.get('action') || 'auth'
    const body = settings[action]
    if (typeof body === 'function') return body(req, res, url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (body !== undefined) return res.end(typeof body === 'string' ? body : JSON.stringify(body))

    if (action === 'auth') {
      return res.end(JSON.stringify({
        user_info: { auth: 1, status: 'Active', active_cons: '0', max_connections: '1' }
      }))
    }
    if (action === 'get_live_categories') {
      return res.end(JSON.stringify([{ category_id: '7', category_name: 'France' }]))
    }
    return res.end(JSON.stringify([
      { stream_id: 1001, name: 'TF1 FHD', stream_icon: 'http://logos.example/tf1.png', epg_channel_id: 'TF1.fr', category_id: '7' },
      { stream_id: 1002, name: 'France 2', stream_icon: '', epg_channel_id: '', category_id: '7' }
    ]))
  })
}

function accountFor (port, extra) {
  return Object.assign({ url: `http://127.0.0.1:${port}`, username: 'user1234', password: 'pass5678' }, extra)
}

test('an account is only used when all three parts are present', () => {
  assert.strictEqual(Xtream.isConfigured({ xtream: { url: 'a', username: 'b', password: 'c' } }), true)
  assert.strictEqual(Xtream.isConfigured({ xtream: { url: 'a', username: 'b' } }), false)
  assert.strictEqual(Xtream.isConfigured({ xtream: {} }), false)
  assert.strictEqual(Xtream.isConfigured({}), false)
  assert.strictEqual(Xtream.isConfigured(undefined), false)
})

test('a bare host is accepted, and a trailing slash does not double up', () => {
  // Providers hand out all of these shapes.
  assert.strictEqual(Xtream.baseUrl({ url: 'line.example.org' }), 'http://line.example.org')
  assert.strictEqual(Xtream.baseUrl({ url: 'line.example.org:8080/' }), 'http://line.example.org:8080')
  assert.strictEqual(Xtream.baseUrl({ url: 'https://line.example.org/' }), 'https://line.example.org')
})

test('credentials with punctuation cannot break out of the query string', () => {
  const account = { url: 'http://line.example.org', username: 'u ser', password: 'p&ss=1' }
  const url = new URL(Xtream.apiUrl(account, { action: 'get_live_streams' }))
  assert.strictEqual(url.searchParams.get('username'), 'u ser')
  assert.strictEqual(url.searchParams.get('password'), 'p&ss=1')
  assert.strictEqual(url.searchParams.get('action'), 'get_live_streams')
})

test('stream URLs are built for both output formats', () => {
  const account = { url: 'http://line.example.org', username: 'u', password: 'p' }
  assert.strictEqual(Xtream.streamUrl(account, 42, 'ts'), 'http://line.example.org/u/p/42.ts')
  assert.strictEqual(Xtream.streamUrl(account, 42, 'm3u8'), 'http://line.example.org/live/u/p/42.m3u8')
  assert.strictEqual(Xtream.streamUrl(account, 42), 'http://line.example.org/u/p/42.ts', 'ts is the default')
})

test('the guide URL comes from the account, with no guessing', () => {
  assert.strictEqual(
    Xtream.epgUrl({ url: 'http://line.example.org', username: 'u', password: 'p' }),
    'http://line.example.org/xmltv.php?username=u&password=p'
  )
})

test('the credentials are handed to the logger so they can be scrubbed', () => {
  assert.deepStrictEqual(Xtream.secrets({ username: 'user1234', password: 'pass5678' }), ['user1234', 'pass5678'])
  // Too short to scrub safely without mangling unrelated log lines.
  assert.deepStrictEqual(Xtream.secrets({ username: 'ab', password: 'cd' }), [])
  assert.deepStrictEqual(Xtream.secrets(undefined), [])
})

test('the catalogue becomes a playlist the rest of the app already understands', async (t) => {
  const { server, port } = await panel()
  t.after(() => server.close())

  const playlist = await Xtream.buildPlaylist(accountFor(port), LOCAL)
  assert.match(playlist, /^#EXTM3U/)
  assert.match(playlist, /tvg-id="TF1\.fr"/)
  assert.match(playlist, /tvg-logo="http:\/\/logos\.example\/tf1\.png"/)
  assert.match(playlist, /group-title="France"/)
  assert.match(playlist, /,TF1 FHD/)
  assert.match(playlist, new RegExp(`http://127\\.0\\.0\\.1:${port}/user1234/pass5678/1001\\.ts`))
})

test('the resulting channels carry logos and guide ids through the normal parser', async (t) => {
  const { server, port } = await panel()
  t.after(() => server.close())

  const playlist = await Xtream.buildPlaylist(accountFor(port), LOCAL)
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false, allowPrivateNetwork: true })

  assert.strictEqual(channels.length, 2)
  assert.strictEqual(channels[0].name, 'TF1 FHD')
  assert.strictEqual(channels[0].logo, 'http://logos.example/tf1.png')
  assert.strictEqual(channels[0].tvgId, 'TF1.fr')
  assert.strictEqual(channels[1].logo, '', 'a stream with no icon simply has none')
})

test('filters work on an Xtream lineup exactly as on a playlist', async (t) => {
  const { server, port } = await panel()
  t.after(() => server.close())

  const playlist = await Xtream.buildPlaylist(accountFor(port), LOCAL)
  const channels = parsePlaylist(playlist, {
    allowPrivateNetwork: true,
    removeIfNotFoundOnFilter: true,
    filter: [{ name: '^TF1', rename: 'TF1', channel: '1' }]
  })
  assert.strictEqual(channels.length, 1)
  assert.strictEqual(channels[0].name, 'TF1')
  assert.strictEqual(channels[0].channel, '1')
})

test('m3u8 output produces HLS stream URLs', async (t) => {
  const { server, port } = await panel()
  t.after(() => server.close())
  const playlist = await Xtream.buildPlaylist(accountFor(port, { output: 'm3u8' }), LOCAL)
  assert.match(playlist, /\/live\/user1234\/pass5678\/1001\.m3u8/)
})

test('a rejected account says what the provider said', async (t) => {
  const { server, port } = await panel({
    auth: { user_info: { auth: 0, message: 'Invalid username or password' } }
  })
  t.after(() => server.close())
  await assert.rejects(() => Xtream.buildPlaylist(accountFor(port), LOCAL), /Invalid username or password/)
})

test('an expired account is reported rather than returning nothing', async (t) => {
  const { server, port } = await panel({
    auth: { user_info: { auth: 1, status: 'Expired' } }
  })
  t.after(() => server.close())
  // Otherwise this shows up as an empty channel list with no explanation.
  await assert.rejects(() => Xtream.buildPlaylist(accountFor(port), LOCAL), /Expired/)
})

test('losing the categories costs the group titles, not the channels', async (t) => {
  const { server, port } = await panel({
    get_live_categories: (req, res) => { res.writeHead(500); res.end('nope') }
  })
  t.after(() => server.close())

  const playlist = await Xtream.buildPlaylist(accountFor(port), LOCAL)
  assert.match(playlist, /,TF1 FHD/, 'the channels are still there')
  assert.match(playlist, /group-title=""/, 'with an empty group')
})

test('a panel that answers with something other than JSON is reported clearly', async (t) => {
  const { server, port } = await panel({ auth: 'this is not json' })
  t.after(() => server.close())
  await assert.rejects(() => Xtream.buildPlaylist(accountFor(port), LOCAL), /did not return valid JSON/)
})

test('a channel name containing a quote cannot corrupt the playlist line', () => {
  // Attribute values are quoted, so an unescaped quote would split the line.
  assert.strictEqual(Xtream.xmlAttribute('Sky "Sports"'), 'Sky Sports')
  assert.strictEqual(Xtream.xmlAttribute('two\nlines'), 'two lines')
  assert.strictEqual(Xtream.xmlAttribute(null), '')
})

test('a hostile channel name cannot inject a second entry', async (t) => {
  const { server, port } = await panel({
    get_live_streams: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify([
        { stream_id: 1, name: 'Evil"\n#EXTINF:-1,Injected\nhttp://evil.example/x.ts', stream_icon: '', epg_channel_id: '', category_id: '7' }
      ]))
    }
  })
  t.after(() => server.close())

  const playlist = await Xtream.buildPlaylist(accountFor(port), LOCAL)
  const channels = parsePlaylist(playlist, { removeIfNotFoundOnFilter: false, allowPrivateNetwork: true })

  assert.strictEqual(channels.length, 1, 'the newline did not create a second channel')
  assert.ok(!channels[0].url.includes('evil.example'), 'and it points at the real stream')
  assert.ok(!channels[0].name.includes(NEWLINE), 'the name was flattened onto one line')

  // The hostile text survives inside the channel name, which is harmless. What
  // matters is that it never becomes a line of its own, because a bare line is
  // what the parser reads as a stream URL.
  const lines = playlist.split(NEWLINE).filter((line) => line.length > 0)
  assert.deepStrictEqual(lines.filter((line) => line.startsWith('http://evil.example')), [])
  assert.strictEqual(lines.filter((line) => line.startsWith('#EXTINF')).length, 1, 'one entry, not two')
})

test('a newline in a channel name is flattened rather than trusted', () => {
  assert.strictEqual(Xtream.displayName('two' + String.fromCharCode(10) + 'lines'), 'two lines')
  assert.strictEqual(Xtream.displayName('  padded  '), 'padded')
  assert.strictEqual(Xtream.displayName(null), '')
})
