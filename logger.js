const packageJson = require('./package.json')
const _ = require('lodash')
if (_.get(process, 'env.DEBUG', false) === false) {
  _.set(process, 'env.DEBUG', `${packageJson.name}:*:info,${packageJson.name}:*:warn,${packageJson.name}:*:error,${packageJson.name}:*:verbose`)
}
const colors = require('colors')
const createDebug = require('debug')
const filendir = require('filendir')
const mainDirectory = process.cwd()
const Moment = require('moment')
const path = require('path')
const rotate = require('log-rotate')
const stackTrace = require('stack-trace')
const util = require('util')
const logPath = `${process.cwd()}/logs.txt`

class Logger {
  constructor () {
    // Declares
    const trace = stackTrace.get()
    trace.splice(0, 1)
    const filename = path.basename(_.first(trace).getFileName(), path.extname(_.first(trace).getFileName())).replace(`${mainDirectory}${path.sep}`, '')
    const namespace = `${packageJson.name}:${filename}`
    const color = this.selectColor(filename)
    this.proceedToRotate = false

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
    this.write = this.write.bind(this)
    this.timestamp = this.timestamp.bind(this)
    this.template = this.template.bind(this)
    this.trace = this.trace.bind(this)
    this.verbose = this.verbose.bind(this)
    this.debug = this.debug.bind(this)
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
    if (!this.proceedToRotate) {
      rotate(logPath, { count: 3 }, () => {
        this.proceedToRotate = true
        this.write(util.format.apply(util, args))
      })
    } else {
      this.write(util.format.apply(util, args))
    }
  }

  write (...args) {
    process.stderr.write(util.format.apply(util, args) + '\n')
    filendir.writeFile(logPath, `${util.format.apply(util, args)}\n`, { flag: 'a+' }, (error) => {
      if (error) {
        process.stderr.write("Didn't succeed to write logs")
        process.exit()
      }
    })
  }

  timestamp () {
    return (new Moment()).format('YYYY/MM/DD HH:mm:ss.SSSS')
  }

  template (logLevel, data) {
    const trace = stackTrace.get()
    trace.splice(0, 2)
    let methodName = ''
    _.forEach(trace, (item) => {
      if (item.getFunctionName() != null) {
        methodName = item.getFunctionName()
        return false
      }
    })
    methodName = colors.green(methodName)
    if (logLevel == null) { logLevel = this._trace }
    const prefix = `${this.timestamp()} ${logLevel.prefix} ${methodName}`
    if (_.isArray(data) && data.length === 1) { data = _.first(data) }
    if (_.isString(data)) {
      logLevel.instance('%s %s', prefix, data)
    } else {
      if (_.isString(_.first(data))) {
        const logMessage = _.first(data)
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

module.exports = Logger
