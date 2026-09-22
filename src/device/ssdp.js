const dgram = require('dgram')
const os = require('os')
const Logger = new (require('../logger'))()

// SSDP discovery, as much of it as an HDHomeRun emulator needs.
//
// This replaces node-ssdp, which is unmaintained and pulls in `ip`, a package
// with an unfixable SSRF advisory (GHSA-2p57-rm9w-gvfp). node-ssdp only ever
// called ip.address() to pick an interface, so the advisory was not reachable
// here, but the only way to clear it is to stop depending on it.
const MULTICAST_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const MAX_AGE = 1800
const DEFAULT_AD_INTERVAL = 10000

/**
 * Picks the local IPv4 address to advertise. When the search came from a known
 * address, an interface on the same subnet is preferred, so a machine with
 * several NICs advertises the one the client can actually reach.
 */
function localAddressFor (peer) {
  const candidates = []
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (entry.internal) continue
      candidates.push(entry)
    }
  }
  if (candidates.length === 0) return '127.0.0.1'
  if (peer) {
    const match = candidates.find((entry) => sameSubnet(entry, peer))
    if (match) return match.address
  }
  return candidates[0].address
}

function toInt (address) {
  const parts = String(address).split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = (value * 256) + octet
  }
  return value
}

function sameSubnet (entry, peer) {
  const address = toInt(entry.address)
  const mask = toInt(entry.netmask)
  const other = toInt(peer)
  if (address === null || mask === null || other === null) return false
  return ((address & mask) >>> 0) === ((other & mask) >>> 0)
}

class SsdpServer {
  constructor (options) {
    const settings = options || {}
    this.port = settings.port
    this.path = settings.path || '/device.xml'
    this.udn = settings.udn
    this.signature = settings.signature || 'UPnP/1.0'
    this.adInterval = settings.adInterval || DEFAULT_AD_INTERVAL
    this.targets = []
    this.socket = null
    this.timer = null
    this.started = false

    this.addUSN = this.addUSN.bind(this)
    this.start = this.start.bind(this)
    this.stop = this.stop.bind(this)
  }

  addUSN (target) {
    if (this.targets.indexOf(target) === -1) this.targets.push(target)
  }

  location (peer) {
    return `http://${localAddressFor(peer)}:${this.port}${this.path}`
  }

  usnFor (target) {
    return target === `uuid:${this.udn}` ? target : `uuid:${this.udn}::${target}`
  }

  start () {
    if (this.started) return
    this.started = true
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket

    socket.on('message', (message, peer) => this.onMessage(message, peer))
    socket.on('error', (error) => {
      // Discovery is a convenience: Plex can always be pointed at the address
      // by hand. Losing port 1900 to another UPnP service on the box must not
      // take the tuner down with it.
      Logger.warn(`SSDP discovery is unavailable (${error.message}). Add the tuner in Plex by address instead.`)
      this.stop()
    })

    socket.bind(SSDP_PORT, () => {
      try {
        socket.addMembership(MULTICAST_ADDRESS)
        socket.setMulticastTTL(4)
      } catch (error) {
        Logger.warn(`Could not join the SSDP multicast group (${error.message}). Add the tuner in Plex by address instead.`)
        this.stop()
        return
      }
      this.announce('ssdp:alive')
      this.timer = setInterval(() => this.announce('ssdp:alive'), this.adInterval)
      if (this.timer.unref) this.timer.unref()
      Logger.verbose('SSDP discovery is listening.')
    })
  }

  onMessage (message, peer) {
    const text = message.toString('utf8')
    if (!text.startsWith('M-SEARCH')) return

    const searchTarget = (text.match(/\r?\nST:[ \t]*(.+)\r?\n/i) || [])[1]
    if (!searchTarget) return
    const wanted = searchTarget.trim()

    const matches = wanted === 'ssdp:all' || wanted === '*'
      ? this.targets
      : this.targets.filter((target) => target === wanted)
    if (matches.length === 0) return

    for (const target of matches) {
      const response = [
        'HTTP/1.1 200 OK',
        `CACHE-CONTROL: max-age=${MAX_AGE}`,
        `DATE: ${new Date().toUTCString()}`,
        'EXT:',
        `LOCATION: ${this.location(peer.address)}`,
        `SERVER: ${this.signature}`,
        `ST: ${target}`,
        `USN: ${this.usnFor(target)}`,
        '',
        ''
      ].join('\r\n')
      this.send(response, peer.port, peer.address)
    }
  }

  announce (kind) {
    for (const target of this.targets) {
      const notify = [
        'NOTIFY * HTTP/1.1',
        `HOST: ${MULTICAST_ADDRESS}:${SSDP_PORT}`,
        `CACHE-CONTROL: max-age=${MAX_AGE}`,
        `LOCATION: ${this.location(null)}`,
        `NT: ${target}`,
        `NTS: ${kind}`,
        `SERVER: ${this.signature}`,
        `USN: ${this.usnFor(target)}`,
        '',
        ''
      ].join('\r\n')
      this.send(notify, SSDP_PORT, MULTICAST_ADDRESS)
    }
  }

  send (text, port, address) {
    if (!this.socket) return
    const payload = Buffer.from(text, 'utf8')
    try {
      this.socket.send(payload, 0, payload.length, port, address, (error) => {
        if (error) Logger.verbose(`SSDP send failed: ${error.message}`)
      })
    } catch (error) {
      Logger.verbose(`SSDP send failed: ${error.message}`)
    }
  }

  stop () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.socket) {
      const socket = this.socket
      this.socket = null
      try {
        socket.close()
      } catch (error) {
        // already closed
      }
    }
    this.started = false
  }
}

module.exports = {
  MULTICAST_ADDRESS,
  SSDP_PORT,
  SsdpServer,
  localAddressFor,
  sameSubnet
}
