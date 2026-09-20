const fs = require('fs')
const path = require('path')
const template = require('./template.json')
const Q = require('q')
const Logger = new (require('./logger'))()
const args = require('args')
let flags = {}
try {
  flags = args.parse(process.argv)
} catch (error) {
  flags = {}
}

// The settings file holds the playlist URL, which for most providers embeds the
// subscriber's username and password. It is written owner-only instead of
// inheriting a world readable default.
const SETTINGS_FILE_MODE = 0o600

class Config {
  constructor () {
    // Declares
    this.filename = flags.settings || process.env.PLEXIPTV_SETTINGS || path.join(process.cwd(), 'settings.json')

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
        process.exit(1)
      })
    return deferred.promise
  }

  readSettings () {
    const deferred = Q.defer()
    Logger.verbose('Reading file...')
    fs.readFile(this.filename, 'utf8', (error, data) => {
      if (error) {
        if (error && error.code === 'ENOENT') {
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
    // Object.assign copies own enumerable properties only, so a "__proto__" key
    // in the settings file lands as a plain property instead of walking up the
    // prototype chain the way a deep merge would.
    const settings = Object.assign({}, template, userSettings)
    const json = JSON.stringify(settings, null, 2)
    try {
      fs.mkdirSync(path.dirname(this.filename), { recursive: true })
    } catch (error) {
      deferred.reject(error)
      return deferred.promise
    }
    fs.writeFile(this.filename, json, { encoding: 'utf8', mode: SETTINGS_FILE_MODE }, (error) => {
      if (error) {
        deferred.reject(error)
      } else {
        // writeFile only applies mode when it creates the file, so an existing
        // file keeps whatever permissions it had. Tighten it explicitly.
        try {
          fs.chmodSync(this.filename, SETTINGS_FILE_MODE)
        } catch (chmodError) {
          Logger.warn(`Could not restrict permissions on ${this.filename}: ${chmodError.message}`)
        }
        deferred.resolve(settings)
      }
    })
    return deferred.promise
  }
}

module.exports = Config
