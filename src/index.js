const path = require('path')
const args = require('args')

args
  .option('logdir', 'The path where the log files will be written', process.env.PLEXIPTV_LOGDIR || path.join(process.cwd(), 'logs'))
  .option('settings', 'Path of the configuration file', process.env.PLEXIPTV_SETTINGS || path.join(process.cwd(), 'settings.json'))

const express = require('express')
const Q = require('q')
const fs = require('fs')
const Preloader = require('./stream/preloader')
const DVR = require('./device/dvr')
const Config = require('./config')
const { fetchText } = require('./net/httpClient')
const { extractCredentials, redactUrl } = require('./net/netGuard')
const { parsePlaylist } = require('./sources/playlist')
const Xtream = require('./sources/xtream')
const { sendSlate } = require('./stream/slate')
const { mount: mountDashboard } = require('./dashboard')
const LoggerClass = require('./logger')
const Logger = new LoggerClass()
const packageJson = require('../package.json')
// Guarded for the same reason as in logger.js: args.parse throws when it
// cannot derive a program name, and the defaults below already cover it.
let flags = {}
try {
  flags = args.parse(process.argv)
} catch (error) {
  flags = {}
}
flags.logdir = flags.logdir || process.env.PLEXIPTV_LOGDIR || path.join(process.cwd(), 'logs')
flags.settings = flags.settings || process.env.PLEXIPTV_SETTINGS || path.join(process.cwd(), 'settings.json')

// The cached playlist mirrors the remote one, credentials and all, so it is
// written owner-only rather than inheriting a world readable default.
const PLAYLIST_FILE_MODE = 0o600

// How much unsent data may pile up in one viewer's socket before the proxy
// starts discarding frames for that viewer. Live TV: dropping is preferable to
// buffering, and buffering without limit is what exhausts the heap.
const MAX_CLIENT_BUFFER_BYTES = 8 * 1024 * 1024
// How many consecutive dropped chunks before the viewer is disconnected
// outright, on the basis that it is never going to catch up.
const MAX_DROPPED_CHUNKS = 512

class Server {
  constructor () {
    this.express = express()
    // Nothing is gained by telling every caller which framework is in use.
    this.express.disable('x-powered-by')
    this.preloader = new Preloader()
    this.config = new Config()
    this.channels = []

    // Bindings
    this.pullPlaylist = this.pullPlaylist.bind(this)
    this.pullXtream = this.pullXtream.bind(this)
    this.readPlaylist = this.readPlaylist.bind(this)
    this.proxy = this.proxy.bind(this)
  }

  init () {
    this.config.init().then(settings => {
      this.settings = settings
      // Teach the logger this subscription's credentials before anything is
      // logged, so they cannot leak through a message redactUrl does not cover.
      for (const secret of extractCredentials(settings.m3u8 && settings.m3u8.remote)) {
        LoggerClass.addSecret(secret)
      }
      for (const secret of Xtream.secrets(settings.xtream)) {
        LoggerClass.addSecret(secret)
      }
      this.express.serverHost = settings.serverHost
      this.express.serverPort = settings.serverPort
      let getPlaylist = this.pullPlaylist
      if (Xtream.isConfigured(settings)) {
        getPlaylist = this.pullXtream
      }
      if (this.settings.doNotPullRemotePlaylist) {
        getPlaylist = this.readPlaylist
      }
      getPlaylist().then((m3u8) => {
        this.channels = parsePlaylist(m3u8, settings)
        process.nextTick(() => {
          const myDvr = new DVR(this)
          myDvr.init()
          this.express.get('/channel/:channelId', this.proxy)
          mountDashboard(this, flags, this.express)
          const httpServer = this.express.listen(this.express.serverPort, this.express.serverHost, () => {
            Logger.info(`Server (v${packageJson.version}) is started at: http://${this.express.serverHost}:${this.express.serverPort}`)
            Logger.info(`Logs output: ${flags.logdir}`)
            Logger.info(`Config file: ${flags.settings}`)
            if (this.express.serverHost === '0.0.0.0' || this.express.serverHost === '::') {
              Logger.warn('Listening on every interface with no authentication. Keep this server on a trusted network, or set "serverHost" to a specific address.')
            }
            Logger.info(`📺🍺~~Enjoy your ${this.channels.length} channels ~~🍺📺\t`)
          })
          // Without this, a port clash surfaces as an unhandled 'error' event
          // and a raw stack trace, which tells the operator nothing useful.
          httpServer.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
              Logger.error(`Port ${this.express.serverPort} is already in use. Stop whatever is using it, or set "serverPort" in ${flags.settings} to a free port.`)
            } else if (error.code === 'EACCES') {
              Logger.error(`Not allowed to bind ${this.express.serverHost}:${this.express.serverPort}. Ports below 1024 usually need elevated privileges.`)
            } else {
              Logger.error('Could not start the server:', error.message)
            }
            process.exit(1)
          })
        })
      }).catch((error) => {
        Logger.error('Failed to get locale playlist:', error)
        process.exit(1)
      })
    })
  }

  readPlaylist () {
    const deferred = Q.defer()
    fs.readFile(this.settings.m3u8.local, 'utf8', (error, body) => {
      if (error) {
        deferred.reject(error)
      } else {
        Logger.warn('Will use local file...')
        deferred.resolve(body)
      }
    })
    return deferred.promise
  }

  /**
   * Builds the channel list from an Xtream account rather than a playlist URL.
   * The catalogue is turned into a playlist so filters, renaming, the limit and
   * the URL checks all behave exactly as they do for a normal m3u.
   */
  pullXtream () {
    const deferred = Q.defer()
    Logger.info(`Reading the Xtream catalogue from: ${Xtream.baseUrl(this.settings.xtream)}`)
    Xtream.buildPlaylist(this.settings.xtream, {
      allowPrivateNetwork: Boolean(this.settings.allowPrivateNetwork)
    }).then((m3u8) => {
      this.savePlaylist(m3u8, deferred)
    }).catch((error) => {
      Logger.error(`Could not read the Xtream account: ${error.message}`)
      // A cached playlist from a previous run is better than no television.
      this.readPlaylist().then((cached) => {
        Logger.warn('Falling back to the last playlist saved to disk.')
        deferred.resolve(cached)
      }).catch(() => deferred.reject(error))
    })
    return deferred.promise
  }

  /**
   * Writes the playlist beside the settings so a later run can fall back to it.
   * It mirrors the provider's catalogue, credentials and all, so it is written
   * owner-only.
   */
  savePlaylist (body, deferred) {
    fs.writeFile(this.settings.m3u8.local, body, { encoding: 'utf8', mode: PLAYLIST_FILE_MODE }, (error) => {
      if (error) {
        deferred.reject(error)
        return
      }
      try {
        fs.chmodSync(this.settings.m3u8.local, PLAYLIST_FILE_MODE)
      } catch (chmodError) {
        Logger.warn(`Could not restrict permissions on ${this.settings.m3u8.local}: ${chmodError.message}`)
      }
      Logger.info(`Successfully saved playlist to: ${this.settings.m3u8.local}`)
      deferred.resolve(body)
    })
  }

  pullPlaylist () {
    const deferred = Q.defer()
    const remote = this.settings.m3u8.remote
    // Provider URLs embed the subscriber's username and password; only the
    // redacted form reaches the log file.
    Logger.info(`Pulling remote playlist: ${redactUrl(remote)}`)
    fetchText(remote, {
      allowPrivateNetwork: Boolean(this.settings.allowPrivateNetwork)
    }).then((body) => {
      Logger.verbose('Writting to local files...')
      fs.writeFile(this.settings.m3u8.local, body, { encoding: 'utf8', mode: PLAYLIST_FILE_MODE }, (error) => {
        if (error) {
          deferred.reject(error)
        } else {
          try {
            fs.chmodSync(this.settings.m3u8.local, PLAYLIST_FILE_MODE)
          } catch (chmodError) {
            Logger.warn(`Could not restrict permissions on ${this.settings.m3u8.local}: ${chmodError.message}`)
          }
          Logger.info(`Successfully saved playlist to: ${this.settings.m3u8.local}`)
          deferred.resolve(body)
        }
      })
    }).catch((error) => {
      Logger.error('Error happen during playlist pull:', error.message)
      this.readPlaylist().then((m3u8) => {
        deferred.resolve(m3u8)
      }).catch((readError) => {
        deferred.reject(readError)
      })
    })
    return deferred.promise
  }

  proxy (req, res, next) {
    Logger.verbose(`Receive a proxy for: ${req.params.channelId}`)
    const line = this.channels.find((candidate) => candidate.channel === req.params.channelId)
    // This check has to happen before the line is touched: the previous order
    // dereferenced `line` first, so any request for an unknown channel threw.
    if (!line) {
      return res.status(404).send('channel id not found')
    }
    // Only used in log messages, and shared between every viewer of the
    // channel, so it is set once instead of being rewritten from whichever
    // client's Host header arrived last.
    if (!line.internalUrl) {
      line.internalUrl = `${req.protocol}://${req.get('host')}/channel/${line.channel}`
    }

    // The opt in has to reach the worker, otherwise a LAN stream the operator
    // deliberately allowed would still be refused when it is fetched.
    const worker = this.preloader.preload(line, {
      allowPrivateNetwork: Boolean(this.settings && this.settings.allowPrivateNetwork)
    })
    // One worker is shared by every viewer of a channel and each viewer adds
    // three listeners, so the default ceiling of 10 would start printing
    // "possible EventEmitter memory leak" warnings at the fourth viewer.
    worker.setMaxListeners(0)
    worker.subscribe()

    let released = false
    let wroteAnything = false
    let droppedChunks = 0

    // If the provider refuses the stream before a single byte was forwarded,
    // say so with a 502 instead of handing the client an empty 200, which
    // looks to Plex like a channel that simply produces nothing.
    const onUpstreamError = (status, explanation) => {
      if (wroteAnything || res.headersSent) return
      release()
      // Shown as video where possible. A 502 makes Plex draw its own generic
      // failure, which tells the viewer nothing; a slate puts the actual
      // reason, such as the line already being in use, on the screen.
      if (sendSlate(res, `Cannot play ${line.name}`, explanation)) return
      res.status(502).type('text/plain').send(`Cannot play ${line.name}: ${explanation}\n`)
    }

    const onData = (buffer) => {
      if (released || res.writableEnded || res.destroyed) return

      // This is where the memory went. res.write() queues in process memory
      // whenever the socket cannot keep up, so one stalled viewer could grow
      // that queue until the process died. The upstream cannot be paused,
      // because other viewers share it, so a viewer that falls behind loses
      // frames rather than the process losing memory, and is disconnected if
      // it never recovers.
      if (res.writableLength > MAX_CLIENT_BUFFER_BYTES) {
        droppedChunks = droppedChunks + 1
        if (droppedChunks > MAX_DROPPED_CHUNKS) {
          Logger.warn(`Dropping a viewer of ${line.name}: it fell ${droppedChunks} chunks behind and never caught up.`)
          release()
          res.destroy()
        }
        return
      }
      if (droppedChunks > 0 && res.writableLength === 0) {
        droppedChunks = 0 // caught up again
      }

      if (!wroteAnything) {
        wroteAnything = true
        res.setHeader('Content-Type', 'video/mp2t')
        res.setHeader('Cache-Control', 'no-store')
      }
      res.write(buffer)
    }

    const onEnd = () => {
      if (released) return
      release()
      if (!res.writableEnded && !res.destroyed) res.end()
    }

    // Hoisted so the handlers above can call it. Idempotent, because both the
    // worker ending and the client leaving have to release the subscription
    // and either can happen first: unsubscribing twice used to push the
    // worker's listener count negative and end it a second time.
    function release () {
      if (released) return
      released = true
      worker.removeListener('data', onData)
      worker.removeListener('end', onEnd)
      worker.removeListener('upstream-error', onUpstreamError)
      worker.unsubscribe()
    }

    worker.on('data', onData)
    worker.once('end', onEnd)
    worker.once('upstream-error', onUpstreamError)

    // 'close' on the response is the dependable "client is gone" signal for a
    // streaming reply. It also fires after a normal finish, which is harmless
    // because release() is idempotent. req 'close' is kept for older clients.
    res.on('close', release)
    req.on('close', release)
  }
}

module.exports = Server

/* istanbul ignore next */
if (require.main === module) {
  const server = new Server()
  server.init()
}
