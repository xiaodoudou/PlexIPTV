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

  preload (line) {
    let guid = md5(line.url)
    let worker = _.get(this.workers, `['${guid}']`, false)
    if (worker === false) {
      worker = new Worker(guid, line)
      _.set(this.workers, `['${guid}']`, worker)
      worker.once('end', (guid) => { this.removeWorker(guid) })
      Logger.verbose(`Create preload for: ${worker.line.internalUrl}`)
    } else {
      Logger.verbose(`Get existing preload for: ${worker.line.internalUrl}`)
    }
    return worker
  }

  removeWorker (guid) {
    let worker = _.get(this.workers, `['${guid}']`, false)
    if (worker !== false) {
      Logger.verbose(`Remove preload for: ${worker.line.internalUrl}`)
      delete this.workers[`${guid}`]
      worker = null
    }
  }
}

module.exports = Preloader
