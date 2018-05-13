const fs = require('fs')
const template = require('./template.json')
const _ = require('lodash')
const Q = require('q')
const Logger = new (require('./logger'))()

class Config {
  constructor () {
    // Declares
    this.filename = 'settings.json'

    // Bindings
    this.init = this.init.bind(this)
    this.readSettings = this.readSettings.bind(this)
    this.mergeWriteSettings = this.mergeWriteSettings.bind(this)
  }

  init () {
    Logger.verbose('Getting settings...')
    const deferred = Q.defer()
    Q.fcall(this.readSettings)
      .then(this.mergeWriteSettings)
      .then((settings) => {
        Logger.verbose('Has resolve settings')
        deferred.resolve(settings)
      })
      .catch(error => {
        Logger.error('Error happen during setting pulling:', error)
        process.exit()
      })
    return deferred.promise
  }

  readSettings () {
    const deferred = Q.defer()
    Logger.verbose('Reading file...')
    fs.readFile(this.filename, 'utf8', (error, data) => {
      if (error) {
        if (_.get(error, 'code', '?') === 'ENOENT') {
          Logger.verbose("Didn't found file, injecting template...")
          deferred.resolve(template)
        } else {
          Logger.verbose('Error happen', error)
          deferred.reject(error)
        }
      } else {
        Logger.verbose('Found file...')
        try {
          const settings = JSON.parse(data)
          deferred.resolve(settings)
        } catch (error) {
          deferred.reject(error)
        }
      }
    })
    return deferred.promise
  }

  mergeWriteSettings (userSettings) {
    const deferred = Q.defer()
    const settings = _.merge({}, template, userSettings)
    const json = JSON.stringify(settings, null, 2)
    fs.writeFile(this.filename, json, 'utf8', (error) => {
      if (error) {
        deferred.reject(error)
      } else {
        deferred.resolve(settings)
      }
    })
    return deferred.promise
  }
}

module.exports = Config
