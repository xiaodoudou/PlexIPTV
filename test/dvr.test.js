require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const DVR = require('../src/device/dvr')
const { escapeXml } = require('../src/device/dvr')

function makeDvr (settings, channels) {
  const server = {
    express: { serverPort: 1234 },
    settings: Object.assign({
      serverName: 'PlexIPTV',
      serialNumber: '0123456789',
      deviceId: '001002003',
      tunerCount: 1
    }, settings),
    channels: channels || []
  }
  return new DVR(server)
}

function fakeReq (host) {
  return { protocol: 'http', get: (header) => (header.toLowerCase() === 'host' ? host : undefined) }
}

test('escapeXml neutralises every XML metacharacter', () => {
  assert.strictEqual(escapeXml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;')
  assert.strictEqual(escapeXml(null), '')
  assert.strictEqual(escapeXml(undefined), '')
  assert.strictEqual(escapeXml(42), '42')
})

test('a hostile serverName cannot break out of the device description', () => {
  const dvr = makeDvr({ serverName: '</friendlyName><script>alert(1)</script><friendlyName>' })
  const xml = dvr.deviceXml(fakeReq('localhost:1234'))
  assert.ok(!xml.includes('<script>'), 'raw script tag must not reach the document')
  assert.ok(xml.includes('&lt;script&gt;'), 'the value is escaped rather than dropped')
  assert.strictEqual(xml.match(/<friendlyName>/g).length, 1, 'exactly one friendlyName element')
})

test('a hostile serialNumber and deviceId cannot inject elements', () => {
  const dvr = makeDvr({
    serialNumber: '123</serialNumber><evil>x</evil><serialNumber>',
    deviceId: '"><inject/>'
  })
  const xml = dvr.deviceXml(fakeReq('localhost:1234'))
  assert.ok(!xml.includes('<evil>'))
  assert.ok(!xml.includes('<inject/>'))
  assert.strictEqual(xml.match(/<serialNumber>/g).length, 1)
})

test('a hostile Host header cannot inject into URLBase', () => {
  const dvr = makeDvr()
  const xml = dvr.deviceXml(fakeReq('evil.test</URLBase><script>x</script><URLBase>'))
  assert.ok(!xml.includes('<script>'))
  assert.strictEqual(xml.match(/<URLBase>/g).length, 1)
})

test('publicUrl in the settings overrides the client supplied Host header', () => {
  const dvr = makeDvr({ publicUrl: 'http://plex.lan:1234/' })
  const xml = dvr.deviceXml(fakeReq('attacker.example'))
  assert.ok(xml.includes('<URLBase>http://plex.lan:1234</URLBase>'), 'trailing slash trimmed, Host ignored')
  assert.ok(!xml.includes('attacker.example'))
})

test('the lineup falls back to the Host header when no publicUrl is configured', () => {
  const dvr = makeDvr({}, [{ channel: '2', name: 'AMC', url: 'http://cdn.example.com/amc.ts' }])
  const lines = dvr.channels(fakeReq('192.168.1.5:1234'))
  assert.deepStrictEqual(lines, [{
    GuideNumber: '2',
    GuideName: 'AMC',
    URL: 'http://192.168.1.5:1234/channel/2'
  }])
})

test('the lineup never leaks the upstream stream URL to the client', () => {
  const dvr = makeDvr({}, [{
    channel: '2',
    name: 'AMC',
    url: 'http://provider.example/get.php?username=abc&password=secret'
  }])
  const serialised = JSON.stringify(dvr.channels(fakeReq('localhost:1234')))
  assert.ok(!serialised.includes('secret'), 'credentials must stay server side')
  assert.ok(!serialised.includes('provider.example'))
})

test('a scan already in progress does not queue a second set of timers', () => {
  const dvr = makeDvr({}, [{ channel: '1', name: 'A', url: 'http://x.example/a' }])
  let scheduled = 0
  const realSetTimeout = global.setTimeout
  global.setTimeout = function (...args) { scheduled++; return realSetTimeout.apply(this, args) }
  try {
    const res = { json () {} }
    dvr.scan({}, res)
    const afterFirst = scheduled
    dvr.scan({}, res)
    dvr.scan({}, res)
    assert.strictEqual(scheduled, afterFirst, 'repeat scan requests must not schedule more work')
  } finally {
    global.setTimeout = realSetTimeout
    dvr.scanInProgress = 0
  }
})

test('lineup status reports the documented shape', () => {
  const dvr = makeDvr()
  assert.deepStrictEqual(dvr.status(), {
    ScanInProgress: 0,
    ScanPossible: 0,
    Source: 'Cable',
    SourceList: ['Cable']
  })
})

test('scan progress is a percentage, not a fraction floored to zero', async () => {
  const channels = []
  for (let i = 0; i < 10; i++) channels.push({ channel: `${i}`, name: `C${i}`, url: `http://x.example/${i}.ts` })
  const dvr = makeDvr({}, channels)

  dvr.scan({}, { json () {} })
  await new Promise((resolve) => setTimeout(resolve, 80))

  // Math.floor(counter / length) is 0 for every channel but the last, so the
  // scan used to sit at 0 and then jump straight to done.
  assert.ok(dvr.scanProgress > 0, `expected progress above 0, got ${dvr.scanProgress}`)
  assert.ok(dvr.scanProgress <= 100, `expected a percentage, got ${dvr.scanProgress}`)
  dvr.scanInProgress = 0
})

test('discover reports the model number, not the model name', () => {
  const dvr = makeDvr()
  let payload = null
  dvr.discover(fakeReq('localhost:1234'), { json (body) { payload = body } })

  assert.strictEqual(payload.ModelNumber, 'HDHR-PLEX-IPTV')
  assert.notStrictEqual(payload.ModelNumber, payload.FirmwareName)
  // The human readable name still appears in device.xml.
  assert.ok(dvr.deviceXml(fakeReq('localhost:1234')).includes('HDHR - Plex - IPTV'))
})
