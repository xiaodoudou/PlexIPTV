const EventEmitter = require('events')

const TICK_INTERVAL = 100
// Upper bound on what may sit in the queue between two ticks. A stalled
// consumer used to be able to grow this without limit and exhaust the heap.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024

class DataStream extends EventEmitter {
  constructor (options) {
    super()

    // Declares
    this._chunks = []
    this._bufferedBytes = 0
    this.maxBufferedBytes = (options && options.maxBufferedBytes) || MAX_BUFFERED_BYTES
    this.droppedChunks = 0
    this.listeners = 0
    this.isEnded = false
    this.timer = null

    // Bindings
    this.tick = this.tick.bind(this)
    this.write = this.write.bind(this)
    this.end = this.end.bind(this)

    // Init
    this.tick()
  }

  tick () {
    const hasData = this._chunks.length !== 0
    while (this._chunks.length) {
      const chunk = this._chunks.shift()
      this._bufferedBytes = this._bufferedBytes - chunk.length
      this.emit('data', chunk)
    }
    if (this._bufferedBytes < 0) this._bufferedBytes = 0
    if (hasData && this._chunks.length === 0) {
      this.emit('empty')
    }
    if (!this.isEnded) {
      this.timer = setTimeout(this.tick, TICK_INTERVAL)
    }
  }

  write (chunk) {
    if (this.isEnded) return false
    const length = chunk && chunk.length ? chunk.length : 0
    if (this._bufferedBytes + length > this.maxBufferedBytes) {
      // Live TV: dropping the newest chunk is preferable to growing the queue
      // until the process dies.
      this.droppedChunks = this.droppedChunks + 1
      this.emit('overflow', this._bufferedBytes)
      return false
    }
    this._chunks.push(chunk)
    this._bufferedBytes = this._bufferedBytes + length
    return true
  }

  end () {
    process.nextTick(() => {
      if (this.isEnded) return
      this.isEnded = true
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
      this._chunks = []
      this._bufferedBytes = 0
      this.emit('end')
    })
  }
}

module.exports = DataStream
module.exports.MAX_BUFFERED_BYTES = MAX_BUFFERED_BYTES
module.exports.TICK_INTERVAL = TICK_INTERVAL
