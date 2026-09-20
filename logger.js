const packageJson = require('./package.json')
if (process.env.DEBUG === undefined || process.env.DEBUG === '') {
  process.env.DEBUG = `${packageJson.name}:*:info,${packageJson.name}:*:warn,${packageJson.name}:*:error,${packageJson.name}:*:verbose`
}
const colors = require('colors')
const createDebug = require('debug')
const fs = require('fs')
const mainDirectory = process.cwd()
const path = require('path')
const rotate = require('log-rotate')
const stackTrace = require('stack-trace')
const util = require('util')
const args = require('args')
// args.parse throws when it cannot derive a program name (embedded use,
// `node -e`, some test runners). Logging must not be what breaks the process.
let flags = {}
try {
  flags = args.parse(process.argv)
} catch (error) {
  flags = {}
}
// Falls back rather than trusting the flag: this module is required by others
// that can be loaded without index.js having registered the option, and
// path.join(undefined, ...) would throw.
const logDir = flags.logdir || process.env.PLEXIPTV_LOGDIR || path.join(process.cwd(), 'logs')
const logPath = path.join(logDir, 'logs.txt')

// Rotation state is per PROCESS, not per Logger. Every module builds its own
// Logger, and each one used to carry its own "have I rotated yet" flag, so a
// single run rotated the log once per module and shredded the history that
// `count: 3` was supposed to keep. Writes that arrive mid-rotation are queued
// rather than dropped.
let rotationState = 'pending'
const pendingWrites = []

function whenRotated (write) {
  if (rotationState === 'done') return write()
  pendingWrites.push(write)
  if (rotationState === 'running') return
  rotationState = 'running'
  rotate(logPath, { count: 3 }, () => {
    rotationState = 'done'
    while (pendingWrites.length) pendingWrites.shift()()
  })
}

// Belt and braces on top of redactUrl(): every known credential is scrubbed
// from every line, whatever shape the message takes. redactUrl only knows the
// URL formats it was taught; this catches the rest, including error messages
// and stack traces from libraries that echo the URL back.
const secrets = new Set()

function addSecret (value) {
  // Very short values would scrub harmless text out of unrelated lines.
  if (typeof value === 'string' && value.length >= 4) secrets.add(value)
}

function scrubSecrets (text) {
  let output = text
  for (const secret of secrets) {
    if (output.includes(secret)) output = output.split(secret).join('***')
  }
  return output
}

// The log file records playlist and stream URLs. Those routinely embed the
// subscriber's username and password, so the file is created for the owner
// only rather than inheriting a world readable default.
const LOG_FILE_MODE = 0o600

function pad (value, length) {
  return String(value).padStart(length, '0')
}

class Logger {
  constructor () {
    // Declares
    const trace = stackTrace.get()
    trace.splice(0, 1)
    const callerFile = trace[0].getFileName()
    const filename = path.basename(callerFile, path.extname(callerFile)).replace(`${mainDirectory}${path.sep}`, '')
    const namespace = `${packageJson.name}:${filename}`
    const color = this.selectColor(filename)
    this.writeFailed = false

    this._trace = {
      value: '👣',
      instance: createDebug(`${namespace}:trace`)
    }
    this._trace.color = color
    this._trace.instance.log = this.log.bind(this)

    this._verbose = {
      prefix: '🔭',
      instance: createDebug(`${namespace}:verbose`)
    }
    this._verbose.color = color
    this._verbose.instance.log = this.log.bind(this)

    this._debug = {
      prefix: '🐛',
      instance: createDebug(`${namespace}:debug`)
    }
    this._debug.color = color
    this._debug.instance.log = this.log.bind(this)

    this._info = {
      prefix: '📟',
      instance: createDebug(`${namespace}:info`)
    }
    this._info.color = color
    this._info.instance.log = this.log.bind(this)

    this._warn = {
      prefix: '⚠️',
      instance: createDebug(`${namespace}:warn`)
    }
    this._warn.color = color
    this._warn.instance.log = this.log.bind(this)

    this._error = {
      prefix: '🔥',
      instance: createDebug(`${namespace}:error`)
    }
    this._error.color = color
    this._error.instance.log = this.log.bind(this)

    // Bindings
    this.selectColor = this.selectColor.bind(this)
    this.write = this.write.bind(this)
    this.timestamp = this.timestamp.bind(this)
    this.template = this.template.bind(this)
    this.trace = this.trace.bind(this)
    this.verbose = this.verbose.bind(this)
    this.debug = this.debug.bind(this)
    this.info = this.info.bind(this)
    this.warn = this.warn.bind(this)
    this.error = this.error.bind(this)
  }

  selectColor (namespace) {
    let hash = 0
    let i
    for (i in namespace) {
      hash = ((hash << 5) - hash) + namespace.charCodeAt(i)
      hash |= 0
    }
    return createDebug.colors[Math.abs(hash) % createDebug.colors.length]
  }

  log (...args) {
    const message = util.format.apply(util, args)
    whenRotated(() => this.write(message))
  }

  write (...args) {
    const line = scrubSecrets(`${util.format.apply(util, args)}\n`)
    process.stderr.write(line)
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.appendFile(logPath, line, { encoding: 'utf8', mode: LOG_FILE_MODE }, (error) => {
        if (error) this.reportWriteFailure(error)
      })
    } catch (error) {
      this.reportWriteFailure(error)
    }
  }

  /**
   * A failing log write must never take the server down with it: that turns a
   * full disk or a bad permission into a remotely reachable denial of service.
   * The failure is reported once and logging degrades to stderr only.
   */
  reportWriteFailure (error) {
    if (this.writeFailed) return
    this.writeFailed = true
    process.stderr.write(`Didn't succeed to write logs to ${logPath}: ${error.message}\n`)
  }

  timestamp () {
    const now = new Date()
    const date = `${now.getFullYear()}/${pad(now.getMonth() + 1, 2)}/${pad(now.getDate(), 2)}`
    const time = `${pad(now.getHours(), 2)}:${pad(now.getMinutes(), 2)}:${pad(now.getSeconds(), 2)}`
    // Matches the 4 character fractional second field the previous format used.
    const fraction = `${pad(now.getMilliseconds(), 3)}0`
    return `${date} ${time}.${fraction}`
  }

  template (logLevel, data) {
    const trace = stackTrace.get()
    trace.splice(0, 2)
    let methodName = ''
    for (const item of trace) {
      if (item.getFunctionName() != null) {
        methodName = item.getFunctionName()
        break
      }
    }
    methodName = colors.green(methodName)
    if (logLevel == null) { logLevel = this._trace }
    const prefix = `${this.timestamp()} ${logLevel.prefix} ${methodName}`
    if (Array.isArray(data) && data.length === 1) { data = data[0] }
    if (typeof data === 'string') {
      logLevel.instance('%s %s', prefix, data)
    } else {
      if (typeof data[0] === 'string') {
        const logMessage = data[0]
        data.splice(0, 1)
        logLevel.instance('%s %s\n%O', prefix, logMessage, data)
      } else {
        logLevel.instance('%s\n%O', prefix, data)
      }
    }
  }

  trace (...data) {
    return this.template(this._trace, data)
  }

  verbose (...data) {
    return this.template(this._verbose, data)
  }

  debug (...data) {
    return this.template(this._debug, data)
  }

  info (...data) {
    return this.template(this._info, data)
  }

  warn (...data) {
    return this.template(this._warn, data)
  }

  error (...data) {
    return this.template(this._error, data)
  }
}

Logger.addSecret = addSecret
Logger.scrubSecrets = scrubSecrets

module.exports = Logger
