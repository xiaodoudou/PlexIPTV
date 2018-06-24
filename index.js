const path = require('path')
const args = require('args')
const _ = require('lodash')

args
  .option('logdir', 'The path where the log files will be written', _.get(process, 'env.PLEXIPTV_LOGDIR', path.join(process.cwd(), 'logs')))
  .option('settings ', 'Path of the configuration file', _.get(process, 'env.PLEXIPTV_SETTINGS', path.join(process.cwd(), 'settings.json')))

const express = require('express')
const Q = require('q')
const request = require('request')
const fs = require('fs')
const validUrl = require('valid-url')
const Preloader = require('./preloader')
const DVR = require('./dvr')
const Config = require('./config')
const Logger = new (require('./logger'))()
const packageJson = require('./package.json')
const flags = args.parse(process.argv)

class Server {
  constructor () {
    this.express = express()
    this.preloader = new Preloader()
    this.config = new Config()
    this.channels = []

    // Bindings
    this.pullPlaylist = this.pullPlaylist.bind(this)
    this.readPlaylist = this.readPlaylist.bind(this)
    this.proxy = this.proxy.bind(this)
  }

  init () {
    this.config.init().then(settings => {
      this.settings = settings
      this.express.serverHost = settings.serverHost
      this.express.serverPort = settings.serverPort
      let getPlaylist = this.pullPlaylist
      if (this.settings.doNotPullRemotePlaylist) {
        getPlaylist = this.readPlaylist
      }
      getPlaylist().then((m3u8) => {
        let defaultChannel = 80000
        const parsingRule = /#EXTINF:(.*),(.*)[\r\n]+(.*)/gm
        let match
        while ((match = parsingRule.exec(m3u8)) !== null) {
          if (match.index === parsingRule.lastIndex) {
            parsingRule.lastIndex++
          }
          if (match.length === 4 && validUrl.isUri(match[3])) {
            const meta = match[1]
            let name = match[2]
            const url = match[3]
            let channel = defaultChannel
            let found = false
            _.forEach(settings.filter, (filter) => {
              let nameFilter = _.get(filter, 'name', false)
              let metaFilter = _.get(filter, 'meta', false)
              if (!nameFilter || !metaFilter) {
                if (nameFilter !== false) {
                  nameFilter = name.search(nameFilter) !== -1
                } else {
                  nameFilter = true
                }
                if (metaFilter !== false) {
                  metaFilter = meta.search(metaFilter) !== -1
                } else {
                  metaFilter = true
                }
                if (nameFilter && metaFilter) {
                  name = _.get(filter, 'rename', name)
                  channel = filter.channel
                  found = true
                  return false
                }
              }
            })
            if (!found && !settings.removeIfNotFoundOnFilter) {
              defaultChannel++
            }
            const line = {
              channel: `${channel}`,
              name,
              url
            }
            if (found || (!found && !settings.removeIfNotFoundOnFilter)) {
              this.channels.push(line)
            }
          }
        }
        this.channels = _.orderBy(this.channels, (line) => {
          return Number(line.channel)
        })
        if (Number(settings.limit) > 0) {
          this.channels = this.channels.slice(0, settings.limit)
        }
        process.nextTick(() => {
          const myDvr = new DVR(this)
          myDvr.init()
          this.express.use('/channel/:channelId', this.proxy)
          this.express.listen(this.express.serverPort, this.express.serverHost, () => {
            Logger.info(`Server (v${packageJson.version}) is started at: http://${this.express.serverHost}:${this.express.serverPort}`)
            Logger.info(`Logs output: ${flags.logdir}`)
            Logger.info(`Config file: ${flags.settings}`)
            Logger.info(`📺🍺~~Enjoy your ${this.channels.length} channels ~~🍺📺\t`)
          })
        })
      }).catch((error) => {
        Logger.error('Failed to get locale playlist:', error)
        process.exit()
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

  pullPlaylist () {
    const deferred = Q.defer()
    Logger.info(`Pulling remote playlist: ${this.settings.m3u8.remote}`)
    request(this.settings.m3u8.remote, (error, response, body) => {
      if (error) {
        Logger.error('Error happen during playlist pull:', error)
        this.readPlaylist().then((m3u8) => {
          deferred.resolve(m3u8)
        }).catch((error) => {
          deferred.reject(error)
        })
      } else {
        Logger.verbose('Writting to local files...')
        fs.writeFile(this.settings.m3u8.local, body, 'utf8', (error) => {
          if (error) {
            deferred.reject(error)
          } else {
            Logger.info(`Sucessfully saved playlist to: ${this.settings.m3u8.local}`)
            deferred.resolve(body)
          }
        })
      }
    })
    return deferred.promise
  }

  proxy (req, res, next) {
    Logger.verbose(`Receive a proxy for: ${req.params.channelId}`)
    const line = _.find(this.channels, (line) => line.channel === req.params.channelId)
    const hostname = req.protocol + '://' + req.get('host')
    line.internalUrl = `${hostname}/channel/${line.channel}`
    if (!line) {
      return res.send('channel id not found')
    }
    let isCanceled = false
    let isEnded = false
    const worker = this.preloader.preload(line)
    worker.subscribe()
    worker.on('data', buffer => {
      if (!isCanceled && !isEnded) {
        res.write(buffer)
      }
    })
    worker.on('end', () => {
      isEnded = true
      if (!isCanceled) res.end()
    })
    req.on('close', () => {
      isCanceled = true
      worker.unsubscribe()
    })
  }
}

const server = new Server()
server.init()
