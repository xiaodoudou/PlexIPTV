const EventEmitter = require('events')

class DataStream extends EventEmitter {
  constructor () {
    super()

    // Declares
    this._chunks = []
    this.listeners = 0
    this.isEnded = false

    // Bindings
    this.tick = this.tick.bind(this)
    this.write = this.write.bind(this)
    this.end = this.end.bind(this)

    // Init
    this.tick()
  }

  tick () {
    var hasData = this._chunks.length !== 0
    while (this._chunks.length) {
      const chunk = this._chunks.shift()
      this.emit('data', chunk)
    }
    if (hasData && this._chunks.length === 0) {
      this.emit('empty')
    }
    if (!this.isEnded) {
      setTimeout(() => {
        this.tick()
      }, 100)
    }
  }

  write (chunck) {
    this._chunks.push(chunck)
  }

  end () {
    process.nextTick(() => {
      this.isEnded = true
      this.emit('end')
    })
  }
}

module.exports = DataStream
