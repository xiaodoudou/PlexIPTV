const EventEmitter = require('events')
const Worker = require('./worker')
const md5 = require('md5')
const Logger = new (require('./logger'))()

class Preloader extends EventEmitter {
  constructor () {
    super()

    // Declares
    // A Map instead of a plain object: worker keys are used as lookup indexes,
    // and a Map cannot be steered into Object.prototype the way a computed
    // property path on an object literal can.
    this.workers = new Map()

    // Bindings
    this.preload = this.preload.bind(this)
    this.removeWorker = this.removeWorker.bind(this)
  }

  preload (line, options) {
    const guid = md5(line.url)
    let worker = this.workers.get(guid)
    if (worker === undefined) {
      worker = new Worker(guid, line, options)
      this.workers.set(guid, worker)
      worker.once('end', (endedGuid) => { this.removeWorker(endedGuid) })
      Logger.verbose(`Create preload for: ${worker.line.internalUrl}`)
    } else {
      Logger.verbose(`Get existing preload for: ${worker.line.internalUrl}`)
    }
    return worker
  }

  removeWorker (guid) {
    const worker = this.workers.get(guid)
    if (worker !== undefined) {
      Logger.verbose(`Remove preload for: ${worker.line.internalUrl}`)
      this.workers.delete(guid)
    }
  }
}

module.exports = Preloader
