require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const dgram = require('node:dgram')
const os = require('node:os')
const { SsdpServer, localAddressFor, sameSubnet } = require('../src/device/ssdp')

test('an interface on the same subnet as the caller is preferred', () => {
  assert.strictEqual(sameSubnet({ address: '192.168.1.10', netmask: '255.255.255.0' }, '192.168.1.55'), true)
  assert.strictEqual(sameSubnet({ address: '192.168.1.10', netmask: '255.255.255.0' }, '10.0.0.5'), false)
  assert.strictEqual(sameSubnet({ address: '10.1.2.3', netmask: '255.0.0.0' }, '10.9.9.9'), true)
  assert.strictEqual(sameSubnet({ address: 'nonsense', netmask: '255.255.255.0' }, '10.0.0.1'), false)
})

test('a local address is always produced', () => {
  const address = localAddressFor(null)
  assert.match(address, /^\d+\.\d+\.\d+\.\d+$/)
  const hasExternal = Object.values(os.networkInterfaces()).some((entries) =>
    (entries || []).some((e) => (e.family === 'IPv4' || e.family === 4) && !e.internal))
  if (hasExternal) assert.notStrictEqual(address, '127.0.0.1')
})

test('an M-SEARCH for a advertised target gets a well formed reply', async (t) => {
  const server = new SsdpServer({ port: 5004, path: '/device.xml', udn: 'test-udn-1234', signature: 'PlexIPTV/0.1 UPnP/1.0', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  server.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1')
  // Drive onMessage directly: binding port 1900 is not reliable in a test run,
  // and the reply is what matters.
  const sent = []
  server.send = (text, port, address) => sent.push({ text, port, address })

  server.onMessage(Buffer.from([
    'M-SEARCH * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'MAN: "ssdp:discover"',
    'MX: 1',
    'ST: upnp:rootdevice',
    '', ''
  ].join('\r\n')), { address: '192.168.1.50', port: 41234 })

  assert.strictEqual(sent.length, 1, 'exactly the matching target answers')
  const reply = sent[0]
  assert.strictEqual(reply.port, 41234, 'answered to the caller, not the multicast group')
  assert.strictEqual(reply.address, '192.168.1.50')
  assert.match(reply.text, /^HTTP\/1\.1 200 OK\r\n/)
  assert.match(reply.text, /\r\nST: upnp:rootdevice\r\n/)
  assert.match(reply.text, /\r\nUSN: uuid:test-udn-1234::upnp:rootdevice\r\n/)
  assert.match(reply.text, /\r\nLOCATION: http:\/\/\d+\.\d+\.\d+\.\d+:5004\/device\.xml\r\n/)
  assert.match(reply.text, /\r\nEXT:\r\n/, 'EXT is required by the UPnP spec')
  assert.match(reply.text, /\r\nCACHE-CONTROL: max-age=\d+\r\n/)
  assert.ok(reply.text.endsWith('\r\n\r\n'), 'headers are terminated')
})

test('ssdp:all returns every advertised target', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  server.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1')
  const sent = []
  server.send = (text) => sent.push(text)
  server.onMessage(Buffer.from('M-SEARCH * HTTP/1.1\r\nST: ssdp:all\r\n\r\n'), { address: '10.0.0.2', port: 9 })
  assert.strictEqual(sent.length, 2)
})

test('an unrelated search target is ignored', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  const sent = []
  server.send = (text) => sent.push(text)
  server.onMessage(Buffer.from('M-SEARCH * HTTP/1.1\r\nST: urn:something:else:1\r\n\r\n'), { address: '10.0.0.2', port: 9 })
  assert.strictEqual(sent.length, 0)
})

test('anything that is not an M-SEARCH is ignored', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  const sent = []
  server.send = (text) => sent.push(text)
  server.onMessage(Buffer.from('NOTIFY * HTTP/1.1\r\nNT: upnp:rootdevice\r\n\r\n'), { address: '10.0.0.2', port: 9 })
  server.onMessage(Buffer.from('garbage'), { address: '10.0.0.2', port: 9 })
  server.onMessage(Buffer.from('M-SEARCH * HTTP/1.1\r\n\r\n'), { address: '10.0.0.2', port: 9 })
  assert.strictEqual(sent.length, 0)
})

test('duplicate targets are only advertised once', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  server.addUSN('upnp:rootdevice')
  assert.deepStrictEqual(server.targets, ['upnp:rootdevice'])
})

test('alive notifications go to the multicast group', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', signature: 'sig', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  const sent = []
  server.send = (text, port, address) => sent.push({ text, port, address })
  server.announce('ssdp:alive')
  assert.strictEqual(sent.length, 1)
  assert.strictEqual(sent[0].address, '239.255.255.250')
  assert.strictEqual(sent[0].port, 1900)
  assert.match(sent[0].text, /^NOTIFY \* HTTP\/1\.1\r\n/)
  assert.match(sent[0].text, /\r\nNTS: ssdp:alive\r\n/)
})

test('losing port 1900 warns instead of taking the tuner down', async (t) => {
  // Something else holding 1900 is common: on Windows the SSDP Discovery
  // service usually has it already. Discovery is optional, so start() must
  // degrade rather than throw or take the process down.
  const squatter = dgram.createSocket({ type: 'udp4', reuseAddr: false })
  const held = await new Promise((resolve) => {
    squatter.once('error', () => resolve(false))
    squatter.bind(1900, () => resolve(true))
  })
  t.after(() => { try { squatter.close() } catch (error) { /* already closed */ } })

  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  server.addUSN('upnp:rootdevice')
  assert.doesNotThrow(() => server.start())
  await new Promise((resolve) => setTimeout(resolve, 500))
  server.stop()

  assert.strictEqual(server.socket, null, 'the socket is released either way')
  assert.strictEqual(server.timer, null)
  if (!held) t.diagnostic('port 1900 was already taken by the host, which is the case under test')
})

test('stop is idempotent and clears the announce timer', () => {
  const server = new SsdpServer({ port: 1234, udn: 'u', adInterval: 60000 })
  assert.doesNotThrow(() => server.stop())
  assert.doesNotThrow(() => server.stop())
  assert.strictEqual(server.timer, null)
})
