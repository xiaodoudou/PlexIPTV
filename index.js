const _ = require('lodash')
const express = require('express')
const Q = require('q')
const request = require('request')
const fs = require('fs')
const validUrl = require('valid-url')
const Preloader = require('./preloader')
const DVR = require('./dvr')
const Config = require('./config')
const Logger = new (require('./logger'))()

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
            const name = match[2]
            const url = match[3]
            let channel = defaultChannel
            let found = false
            _.forEach(settings.filter, (filter) => {
              if (name.search(filter.name) !== -1) {
                channel = filter.channel
                found = true
                return false
              }
            })
            if (!found && !settings.removeIfNotFoundOnFilter) {
              defaultChannel++
            }
            const line = {
              channel,
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
        const myDvr = new DVR(this)
        myDvr.init()
        this.express.use('/channel/:channelId', this.proxy)
        this.express.listen(this.express.serverPort, () => {
          Logger.info(`Server is started at: http://localhost:${this.express.serverPort} \t📺🍺~~ Enjoy ~~🍺📺\t`)
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
        Logger.warn('Fallback using local file...')
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
    const currentChannel = _.find(this.channels, (line) => line.channel === req.params.channelId)
    if (!currentChannel) {
      return res.send('channel id not found')
    }
    let isCanceled = false
    let isEnded = false
    const worker = this.preloader.preload(currentChannel.url)
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
