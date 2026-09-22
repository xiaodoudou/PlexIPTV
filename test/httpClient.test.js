require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const { fetchText, streamRequest } = require('../src/net/httpClient')

// The test servers live on loopback, which the guard blocks by design, so
// these tests opt in explicitly. That doubles as coverage of the opt in.
const LOCAL = { allowPrivateNetwork: true }

function listen (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('fetchText downloads a body', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('#EXTM3U\n')
  })
  t.after(() => server.close())
  assert.strictEqual(await fetchText(`http://127.0.0.1:${port}/list.m3u8`, LOCAL), '#EXTM3U\n')
})

test('fetchText rejects a non 2xx response instead of treating it as a playlist', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(403)
    res.end('nope')
  })
  t.after(() => server.close())
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${port}/list.m3u8`, LOCAL),
    /Unexpected status 403/
  )
})

test('fetchText refuses a response larger than the cap', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200)
    // Far larger than the cap the request sets below.
    const chunk = Buffer.alloc(64 * 1024, 0x41)
    for (let i = 0; i < 64; i++) res.write(chunk)
    res.end()
  })
  t.after(() => server.close())
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${port}/big.m3u8`, { allowPrivateNetwork: true, maxBytes: 1024 }),
    /exceeded 1024 bytes/
  )
})

test('a request to a private address is refused unless opted in', async (t) => {
  const { server, port } = await listen((req, res) => res.end('should never be read'))
  t.after(() => server.close())
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${port}/x`),
    /private network address/
  )
})

test('a non http protocol never reaches the network', async () => {
  await assert.rejects(() => fetchText('file:///etc/passwd', LOCAL), /unsupported protocol/)
  await assert.rejects(() => fetchText('ftp://example.com/x', LOCAL), /unsupported protocol/)
})

test('redirects are followed', async (t) => {
  const { server, port } = await listen((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final' })
      return res.end()
    }
    res.writeHead(200)
    res.end('arrived')
  })
  t.after(() => server.close())
  assert.strictEqual(await fetchText(`http://127.0.0.1:${port}/start`, LOCAL), 'arrived')
})

test('a redirect loop is cut off rather than followed forever', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(302, { Location: '/loop' })
    res.end()
  })
  t.after(() => server.close())
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${port}/loop`, { allowPrivateNetwork: true, maxRedirects: 2 }),
    /Too many redirects/
  )
})

test('a redirect is re-validated, so it cannot escape to another protocol', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(302, { Location: 'file:///etc/passwd' })
    res.end()
  })
  t.after(() => server.close())
  await assert.rejects(
    () => fetchText(`http://127.0.0.1:${port}/jump`, LOCAL),
    /unsupported protocol/
  )
})

test('abort stops delivering data', async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200)
    const timer = setInterval(() => res.write('x'.repeat(256)), 5)
    req.on('close', () => clearInterval(timer))
  })
  t.after(() => server.close())

  const request = streamRequest(`http://127.0.0.1:${port}/stream`, LOCAL)
  let chunks = 0
  request.on('error', () => {})
  await new Promise((resolve) => {
    request.on('data', () => {
      chunks++
      if (chunks === 1) {
        request.abort()
        setTimeout(resolve, 60)
      }
    })
  })
  assert.strictEqual(chunks, 1, 'no further chunks after abort')
})

test('listeners attached after the call still receive events', async (t) => {
  const { server, port } = await listen((req, res) => { res.writeHead(200); res.end('ok') })
  t.after(() => server.close())
  const request = streamRequest(`http://127.0.0.1:${port}/x`, LOCAL)
  // Attached synchronously after construction: the client must not have
  // emitted anything yet.
  const body = await new Promise((resolve, reject) => {
    const parts = []
    request.on('data', (chunk) => parts.push(chunk))
    request.on('end', () => resolve(Buffer.concat(parts).toString()))
    request.on('error', reject)
  })
  assert.strictEqual(body, 'ok')
})
