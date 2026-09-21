const { SsdpServer } = require('./ssdp')
const { buildChannelElements, buildIdMap, guessEpgUrl, pipeProgrammes } = require('./xmltv')
const Xtream = require('./xtream')
const NEWLINE = String.fromCharCode(10)
const Logger = new (require('./logger'))()

/**
 * Escapes text before it is interpolated into the device description XML.
 * Every field below originates from the settings file or from the client
 * supplied Host header, so without this a value such as `</friendlyName>...`
 * would let a caller rewrite the document Plex parses.
 */
function escapeXml (value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

class DVR {
  constructor (server) {
    // Declares
    this.version = {
      major: 0,
      minor: 1
    }
    this.server = server
    this.express = this.server.express
    this.scanPossible = 0
    this.scanInProgress = 0
    this.scanFound = 0
    this.scanProgress = 0
    this.friendlyName = this.server.settings.serverName
    this.manufacturer = 'Silicondust'
    this.modelName = 'HDHR - Plex - IPTV'
    this.modelNumber = 'HDHR-PLEX-IPTV'
    this.serialNumber = this.server.settings.serialNumber
    this.deviceId = this.server.settings.deviceId
    this.firmwareVersion = `${this.version.major}.${this.version.minor}`
    this.firmwareName = `plex-iptv-${this.firmwareVersion}`
    this.tunerCount = this.server.settings.tunerCount
    this.deviceAuth = 'user123'
    this.lineupUrl = '/lineup.json'
    this.scanUrl = '/lineup.post'
    this.lineStatusUrl = '/lineup_status.json'
    this.discoverUrl = '/discover.json'
    this.deviceUrl = '/device.xml'
    this.guideUrl = '/xmltv.xml'

    // Bindings
    this.init = this.init.bind(this)
    this.channels = this.channels.bind(this)
    this.lineup = this.lineup.bind(this)
    this.scan = this.scan.bind(this)
    this.lineupStatus = this.lineupStatus.bind(this)
    this.discover = this.discover.bind(this)
    this.device = this.device.bind(this)
    this.guide = this.guide.bind(this)
  }

  init () {
    // `all` rather than `use`: `use` matches by prefix, so it also answered
    // requests for paths such as /lineup.json/anything.
    this.express.all(this.lineupUrl, this.lineup)
    this.express.all(this.scanUrl, this.scan)
    this.express.all(this.lineStatusUrl, this.lineupStatus)
    this.express.all(this.discoverUrl, this.discover)
    this.express.all(this.deviceUrl, this.device)
    this.express.all(this.guideUrl, this.guide)
    this.ssdpServer = new SsdpServer({
      port: this.express.serverPort,
      path: '/device.xml',
      udn: `f10c2345-7329-40b7-8b04-27${this.serialNumber}`,
      adInterval: 5000,
      signature: `${this.friendlyName}/${this.firmwareVersion} UPnP/1.0`
    })

    this.ssdpServer.addUSN('upnp:rootdevice')
    this.ssdpServer.addUSN('urn:schemas-upnp-org:device:MediassdpServer:1')
    this.ssdpServer.addUSN('urn:schemas-upnp-org:service:ContentDirectory:1')
    this.ssdpServer.addUSN('urn:schemas-upnp-org:service:ConnectionManager:1')
    this.ssdpServer.start()
    Logger.verbose('DVR is now initiated.')
  }

  /**
   * Builds the base URL advertised back to Plex. The Host header is client
   * controlled, so it is only trusted when the settings pin a server name.
   */
  baseUrl (req) {
    const configured = this.server.settings.publicUrl
    if (typeof configured === 'string' && configured.length > 0) {
      return configured.replace(/\/+$/, '')
    }
    return `${req.protocol}://${req.get('host')}`
  }

  channels (req) {
    const hostname = this.baseUrl(req)
    const lines = []
    for (const line of this.server.channels) {
      lines.push({
        GuideNumber: line.channel,
        GuideName: line.name,
        URL: `${hostname}/channel/${encodeURIComponent(line.channel)}`
      })
    }
    Logger.verbose(`Return ${lines.length} channels.`)
    return lines
  }

  lineup (req, res, next) {
    Logger.verbose('Received a lineup request.')
    res.json(this.channels(req))
  }

  scan (req, res, next) {
    Logger.verbose('Received a scan request.')
    process.nextTick(() => {
      res.json({})
    })
    // Without this guard every unauthenticated request to /lineup.post queued
    // another timer per channel, so repeated calls pile up timers unbounded.
    if (this.scanInProgress) {
      Logger.verbose('A scan is already running, ignoring the request.')
      return
    }
    this.scanPossible = 0
    this.scanInProgress = 1
    const delay = 10
    let progressDelay = delay
    let counter = 1
    for (const item of this.server.channels) { // eslint-disable-line no-unused-vars
      setTimeout(() => {
        this.scanFound = counter
        // A fraction floored to an integer is 0 until the very last channel,
        // so the scan appeared stuck at 0% throughout.
        this.scanProgress = Math.floor((counter / this.server.channels.length) * 100)
        counter = counter + 1
      }, progressDelay)
      progressDelay = delay + progressDelay
    }
    setTimeout(() => {
      this.scanPossible = 1
      this.scanInProgress = 0
    }, progressDelay)
  }

  status () {
    let status = {
      ScanInProgress: this.scanInProgress,
      ScanPossible: this.scanPossible,
      Source: 'Cable',
      SourceList: ['Cable']
    }
    if (this.scanInProgress) {
      status = {
        ScanInProgress: this.scanInProgress,
        Progress: this.scanProgress,
        Found: this.scanFound
      }
    }

    return status
  }

  lineupStatus (req, res, next) {
    Logger.verbose('Received a lineup status request.')
    res.json(this.status())
  }

  discover (req, res, next) {
    Logger.verbose('Received a discover request.')
    const baseUrl = this.baseUrl(req)
    const status = {
      FriendlyName: this.friendlyName,
      Manufacturer: this.manufacturer,
      ModelNumber: this.modelNumber,
      FirmwareName: this.firmwareName,
      TunerCount: this.tunerCount,
      FirmwareVersion: this.firmwareVersion,
      DeviceID: this.deviceId,
      DeviceAuth: this.deviceAuth,
      BaseURL: baseUrl,
      LineupURL: `${baseUrl}${this.lineupUrl}`
    }
    res.json(status)
  }

  deviceXml (req) {
    const baseUrl = this.baseUrl(req)
    return `<root xmlns="urn:schemas-upnp-org:device-1-0">
        <specVersion>
            <major>${escapeXml(this.version.major)}</major>
            <minor>${escapeXml(this.version.minor)}</minor>
        </specVersion>
        <URLBase>${escapeXml(baseUrl)}</URLBase>
        <device>
          <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
          <friendlyName>${escapeXml(this.friendlyName)}</friendlyName>
          <manufacturer>${escapeXml(this.manufacturer)}</manufacturer>
          <modelName>${escapeXml(this.modelName)}</modelName>
          <modelNumber>${escapeXml(this.modelNumber)}</modelNumber>
          <serialNumber>${escapeXml(this.serialNumber)}</serialNumber>
          <UDN>uuid:${escapeXml(this.deviceId)}</UDN>
        </device>
      </root>`
  }

  /**
   * The XMLTV guide, which is the only route by which a channel logo can reach
   * Plex: the HDHomeRun lineup format has no field for one.
   *
   * Entirely best effort. Channels and their logos go out immediately, and the
   * provider's programme data is streamed in after them if there is any. No
   * guide, a slow guide or a broken guide costs you programme listings and
   * nothing else; the channels still work.
   */
  guide (req, res, next) {
    Logger.verbose('Received a guide request.')
    const settings = this.server.settings || {}
    const configured = typeof settings.epgUrl === 'string' ? settings.epgUrl.trim() : ''
    let epgUrl = configured
    if (epgUrl.length === 0 && Xtream.isConfigured(settings)) {
      // The account already says where its guide lives, so there is nothing to
      // infer from a playlist URL.
      epgUrl = Xtream.epgUrl(settings.xtream)
    }
    if (epgUrl.length === 0) {
      epgUrl = guessEpgUrl(settings.m3u8 && settings.m3u8.remote)
    }

    res.set('Content-Type', 'application/xml; charset=utf-8')
    res.set('X-Content-Type-Options', 'nosniff')
    res.write('<?xml version="1.0" encoding="UTF-8" ?>\n')
    res.write('<tv generator-info-name="PlexIPTV">\n')
    res.write(buildChannelElements(this.server.channels))
    res.write('\n')

    const withLogos = this.server.channels.filter((line) => line.logo).length
    Logger.verbose(`Guide: ${this.server.channels.length} channels, ${withLogos} with a logo.`)

    if (epgUrl.length === 0) {
      Logger.verbose('No guide URL is configured or derivable, serving channels only.')
      res.end('</tv>' + NEWLINE)
      return
    }

    let closed = false
    req.on('close', () => { closed = true })

    pipeProgrammes(epgUrl, buildIdMap(this.server.channels), {
      allowPrivateNetwork: Boolean(settings.allowPrivateNetwork)
    }, (text) => {
      if (!closed && !res.writableEnded) res.write(text)
    }).then(() => {
      if (!closed && !res.writableEnded) res.end('</tv>' + NEWLINE)
    })
  }

  device (req, res, next) {
    Logger.verbose('Received a device identify request.')
    // An explicit charset stops a browser from sniffing the response into
    // something it will execute.
    res.set('Content-Type', 'text/xml; charset=utf-8')
    res.set('X-Content-Type-Options', 'nosniff')
    res.send(this.deviceXml(req))
  }
}

module.exports = DVR
module.exports.escapeXml = escapeXml
