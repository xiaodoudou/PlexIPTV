const _ = require('lodash')
const EventEmitter = require('events')
const once = require('once') // eslint-disable-line no-unused-vars
const Worker = require('./worker')
const md5 = require('md5')
const Logger = new (require('./logger'))()

class Preloader extends EventEmitter {
  constructor () {
    super()

    // Declares
    this.workers = {}

    // Bindings
    this.preload = this.preload.bind(this)
    this.removeWorker = this.removeWorker.bind(this)
  }

  preload (url) {
    let guid = md5(url)
    let worker = _.get(this.workers, `['${guid}']`, false)
    if (worker === false) {
      worker = new Worker(guid, url)
      _.set(this.workers, `['${guid}']`, worker)
      worker.once('end', (guid) => { this.removeWorker(guid) })
      Logger.verbose(`Create preload for: ${worker.url}`)
    } else {
      Logger.verbose(`Get existing preload for: ${worker.url}`)
    }
    return worker
  }

  removeWorker (guid) {
    let worker = _.get(this.workers, `['${guid}']`, false)
    if (worker !== false) {
      Logger.verbose(`Remove preload for: ${worker.url}`)
      delete this.workers[`${guid}`]
      worker = null
    }
  }
}

module.exports = Preloader
