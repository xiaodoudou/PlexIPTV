require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { assertSafeUrl, extractCredentials, guardedLookup, isPrivateAddress, redactUrl, redactUrlsInText } = require('../src/net/netGuard')

test('assertSafeUrl accepts ordinary public http and https URLs', () => {
  assert.strictEqual(assertSafeUrl('http://example.com/a.m3u8').protocol, 'http:')
  assert.strictEqual(assertSafeUrl('https://example.com/a.m3u8').protocol, 'https:')
  assert.strictEqual(assertSafeUrl('http://8.8.8.8:8080/stream').hostname, '8.8.8.8')
})

test('assertSafeUrl rejects every protocol other than http and https', () => {
  // valid-url's isUri, which this replaced, happily accepted all of these.
  for (const url of [
    'file:///etc/passwd',
    'file://C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'gopher://example.com/',
    'ftp://example.com/x',
    'ws://example.com/'
  ]) {
    assert.throws(() => assertSafeUrl(url), /unsupported protocol|malformed/i, `expected ${url} to be refused`)
  }
})

test('assertSafeUrl rejects an empty or malformed URL', () => {
  assert.throws(() => assertSafeUrl(''), /empty/i)
  assert.throws(() => assertSafeUrl('   '), /empty/i)
  assert.throws(() => assertSafeUrl(undefined), /empty/i)
  assert.throws(() => assertSafeUrl('not a url'), /malformed/i)
})

test('assertSafeUrl rejects literal private, loopback and link local addresses', () => {
  for (const host of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '172.16.4.4',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud instance metadata
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255'
  ]) {
    assert.throws(
      () => assertSafeUrl(`http://${host}/stream`),
      /private network address/,
      `expected ${host} to be refused`
    )
  }
})

test('assertSafeUrl rejects private IPv6 addresses including IPv4 mapped forms', () => {
  for (const host of ['[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]']) {
    assert.throws(
      () => assertSafeUrl(`http://${host}/stream`),
      /private network address/,
      `expected ${host} to be refused`
    )
  }
})

test('assertSafeUrl allows private addresses only when explicitly opted in', () => {
  assert.throws(() => assertSafeUrl('http://192.168.0.10/stream'))
  const parsed = assertSafeUrl('http://192.168.0.10/stream', { allowPrivateNetwork: true })
  assert.strictEqual(parsed.hostname, '192.168.0.10')
  // The opt in must not re-open non-http schemes.
  assert.throws(() => assertSafeUrl('file:///etc/passwd', { allowPrivateNetwork: true }), /unsupported protocol/)
})

test('isPrivateAddress leaves public addresses alone', () => {
  for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.167.0.1', '2606:4700::1111']) {
    assert.strictEqual(isPrivateAddress(host), false, `${host} should be public`)
  }
})

test('redactUrl removes credentials and query strings from log output', () => {
  const redacted = redactUrl('http://line.example.org/get.php?username=abc123&password=s3cret&type=m3u_plus')
  assert.ok(!redacted.includes('abc123'), 'username must not survive redaction')
  assert.ok(!redacted.includes('s3cret'), 'password must not survive redaction')
  assert.ok(redacted.includes('line.example.org'), 'host is still useful for diagnostics')

  const withUserinfo = redactUrl('http://bob:hunter2@example.com/playlist.m3u8')
  assert.ok(!withUserinfo.includes('hunter2'), 'userinfo password must not survive redaction')
  assert.ok(!withUserinfo.includes('bob'), 'userinfo username must not survive redaction')
})

test('redactUrl still scrubs a string it cannot parse', () => {
  const redacted = redactUrl('//user:pass@host/x?token=abcdef')
  assert.ok(!redacted.includes('pass'))
  assert.ok(!redacted.includes('abcdef'))
})

test('guardedLookup refuses a hostname that resolves to a private address', (t, done) => {
  // localhost resolves inward on every platform: the ideal DNS rebinding stand in.
  guardedLookup('localhost', {}, (error) => {
    assert.ok(error, 'expected localhost to be refused')
    assert.match(error.message, /private network address/)
    done()
  })
})

test('redactUrl strips Xtream credentials carried in the PATH, not just the query', () => {
  // Regression: Xtream Codes serves streams as /<user>/<pass>/<id>.ts, so
  // redacting only userinfo and the query left the password in the log.
  const redacted = redactUrl('http://line.example.org/subuser123/subpass456/506638.ts')
  assert.ok(!redacted.includes('subuser123'), 'username must not survive')
  assert.ok(!redacted.includes('subpass456'), 'password must not survive')
  assert.ok(redacted.includes('506638'), 'the stream id is still useful')
  assert.ok(redacted.includes('line.example.org'), 'the host is still useful')
})

test('redactUrl handles the live, movie and series path prefixes', () => {
  for (const prefix of ['live', 'movie', 'series']) {
    const redacted = redactUrl(`http://line.example.org/${prefix}/subuser123/subpass456/506638.m3u8`)
    assert.ok(!redacted.includes('subpass456'), `${prefix} password must not survive`)
    assert.ok(redacted.includes(prefix), `${prefix} prefix is preserved`)
  }
})

test('redactUrl leaves an ordinary CDN path alone', () => {
  // Over-redaction would make the log useless for diagnosing normal providers.
  const url = 'http://cdn.example.com/hls/news/stream.ts'
  assert.strictEqual(redactUrl(url), url)
  assert.strictEqual(redactUrl('http://cdn.example.com/a/b/c.ts'), 'http://cdn.example.com/a/b/c.ts')
})

test('extractCredentials finds credentials in every provider URL shape', () => {
  assert.deepStrictEqual(
    extractCredentials('http://line.example.org/subuser123/subpass456/506638.ts'),
    ['subuser123', 'subpass456']
  )
  assert.deepStrictEqual(
    extractCredentials('http://line.example.org/get.php?username=subuser123&password=subpass456&type=m3u_plus'),
    ['subuser123', 'subpass456']
  )
  assert.deepStrictEqual(
    extractCredentials('http://subuser123:subpass456@line.example.org/playlist.m3u8'),
    ['subuser123', 'subpass456']
  )
  assert.deepStrictEqual(extractCredentials('http://cdn.example.com/hls/news/stream.ts'), [])
  assert.deepStrictEqual(extractCredentials('not a url'), [])
  assert.deepStrictEqual(extractCredentials(undefined), [])
})

test('extractCredentials ignores values too short to scrub safely', () => {
  // Scrubbing a 2-character value would mangle unrelated log lines.
  assert.deepStrictEqual(extractCredentials('http://line.example.org/get.php?username=ab&password=cd'), [])
})

test('redactUrlsInText strips credentials from a URL quoted inside a message', () => {
  // The exact shape ffmpeg writes to stderr, which remux.js forwards to the log.
  assert.strictEqual(
    redactUrlsInText('Error opening input file rtsp://testuser0000:testpass0000@cdn.example.com/live.'),
    'Error opening input file rtsp://***:***@cdn.example.com/live.'
  )
})

test('redactUrlsInText covers Xtream credentials carried in the path', () => {
  assert.strictEqual(
    redactUrlsInText('Opening http://line.example.org/subuser123/subpass456/4242.ts for reading'),
    'Opening http://line.example.org/***/***/4242.ts for reading'
  )
})

test('redactUrlsInText redacts every URL in the line, not just the first', () => {
  assert.strictEqual(
    redactUrlsInText('rtsp://u1234:p5678@a/live and http://b/c?token=sixteencharacters'),
    'rtsp://***:***@a/live and http://b/c?<redacted>'
  )
})

test('redactUrlsInText leaves a message with no URL alone', () => {
  // A bare hostname is not a credential, and mangling ordinary diagnostics
  // would make the log harder to read for no gain.
  const message = '[tcp @ 0x1] Failed to resolve hostname cdn.example.com: no such host'
  assert.strictEqual(redactUrlsInText(message), message)
})

test('redactUrlsInText does not throw on a non string', () => {
  assert.strictEqual(redactUrlsInText(undefined), 'undefined')
  assert.strictEqual(redactUrlsInText(null), 'null')
})
