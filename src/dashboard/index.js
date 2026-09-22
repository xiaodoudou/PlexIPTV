const express = require('express')
const LoggerClass = require('../logger')
const Logger = new LoggerClass()
const auth = require('./auth')
const snapshot = require('./snapshot')
const page = require('./page')

const COOKIE_NAME = 'plexiptv_dashboard'
const DASHBOARD_PATH = '/dashboard'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_REFRESH_SECONDS = 10
// A login form has no business accepting a large body.
const LOGIN_BODY_LIMIT = '1kb'

function parseCookies (header) {
  const jar = {}
  if (typeof header !== 'string') return jar
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 1) continue
    const name = part.slice(0, eq).trim()
    if (name.length === 0) continue
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim())
    } catch (error) {
      // A malformed cookie is simply not a cookie.
    }
  }
  return jar
}

function clientKey (req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'
}

function isSecureRequest (req) {
  if (req.secure) return true
  return String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https'
}

function setSessionCookie (req, res, token, base) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=${base || '/'}`,
    'HttpOnly',
    // Strict rather than Lax: nothing links into the dashboard from elsewhere,
    // and it means no other site can carry the session into a request.
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ]
  if (isSecureRequest(req)) attributes.push('Secure')
  res.setHeader('Set-Cookie', attributes.join('; '))
}

function clearSessionCookie (res, base) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=${base || '/'}; HttpOnly; SameSite=Strict; Max-Age=0`)
}

/**
 * Makes sure there is a verifier and a session secret to work with.
 *
 * A dashboard that defaults to no password would be worse than no dashboard, so
 * when none is configured one is generated. The plaintext is written to the
 * console once and never to the log file, and it is registered as a secret so
 * it cannot surface in a log line later. Only the scrypt verifier reaches disk.
 */
function ensureCredentials (server) {
  const settings = server.settings || {}
  const dashboard = Object.assign({}, settings.dashboard)
  let generated = null
  let changed = false

  if (typeof dashboard.password !== 'string' || dashboard.password.length === 0) {
    generated = auth.generatePassword()
    dashboard.password = auth.hashPassword(generated)
    changed = true
  } else if (!dashboard.password.startsWith(`${auth.SCHEME}$`)) {
    // A password typed straight into settings.json as plaintext: hash it in
    // place so it does not sit on disk readable, and keep it working.
    LoggerClass.addSecret(dashboard.password)
    dashboard.password = auth.hashPassword(dashboard.password)
    changed = true
    Logger.warn('The dashboard password in settings.json was stored in clear text. It has been replaced with a hash of the same password.')
  }

  if (typeof dashboard.sessionSecret !== 'string' || dashboard.sessionSecret.length < 32) {
    dashboard.sessionSecret = auth.generateSessionSecret()
    changed = true
  }

  settings.dashboard = dashboard
  server.settings = settings

  if (generated) {
    LoggerClass.addSecret(generated)
    // Deliberately not Logger: the log file is not access controlled, and this
    // is the one value that must not be in it.
    process.stdout.write(
      '\n  PlexIPTV dashboard\n' +
      '  A password was generated because none was set.\n' +
      `  Password: ${generated}\n` +
      '  It is shown once, and only its hash is saved.\n' +
      '  Set dashboard.password in settings.json to choose your own.\n\n'
    )
  }

  if (changed && server.config && typeof server.config.mergeWriteSettings === 'function') {
    // Persisted in the background: the dashboard already has what it needs in
    // memory, and a slow disk should not hold up the server starting.
    Promise.resolve(server.config.mergeWriteSettings(settings)).then(null, (error) => {
      Logger.warn(`Could not save the dashboard credentials: ${error.message}. A new password will be generated on the next start.`)
    })
  }

  return dashboard
}

/**
 * The dashboard router.
 *
 * Mounted under its own path, so nothing here is ever in front of the endpoints
 * Plex calls. Plex cannot log in, and putting authentication in front of
 * /device.xml, /lineup.json or the channel URLs would simply break the tuner.
 */
function createDashboard (server, flags) {
  const router = express.Router()
  const credentials = ensureCredentials(server)
  const limiter = new auth.LoginLimiter()
  const refreshSeconds = server.settings.dashboard.refreshSeconds != null
    ? Number(server.settings.dashboard.refreshSeconds)
    : DEFAULT_REFRESH_SECONDS

  const base = (req) => req.baseUrl || ''

  function isAuthenticated (req) {
    const jar = parseCookies(req.get('cookie'))
    return auth.verifySession(credentials.sessionSecret, jar[COOKIE_NAME])
  }

  function requireSession (req, res, next) {
    if (isAuthenticated(req)) return next()
    if (req.accepts(['html', 'json']) === 'json') {
      return res.status(401).json({ error: 'authentication required' })
    }
    return res.redirect(`${base(req)}/login`)
  }

  // A status page should not be cached by anything, least of all a proxy.
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    // Everything is inline and self contained, so nothing needs to be fetched.
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
    next()
  })

  router.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect(base(req) || '/')
    res.type('html').send(page.renderLogin({ base: base(req) }))
  })

  router.post('/login', express.urlencoded({ extended: false, limit: LOGIN_BODY_LIMIT }), (req, res) => {
    const key = clientKey(req)
    if (limiter.isBlocked(key)) {
      const seconds = limiter.retryAfterSeconds(key)
      res.setHeader('Retry-After', String(seconds))
      Logger.warn(`Dashboard login blocked for ${key}: too many failed attempts.`)
      return res.status(429).type('html').send(page.renderLogin({
        base: base(req),
        error: `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`
      }))
    }

    const password = req.body && typeof req.body.password === 'string' ? req.body.password : ''
    if (!auth.verifyPassword(password, credentials.password)) {
      limiter.recordFailure(key)
      Logger.warn(`Failed dashboard login from ${key}.`)
      return res.status(401).type('html').send(page.renderLogin({
        base: base(req),
        error: 'That password is not right.'
      }))
    }

    limiter.reset(key)
    setSessionCookie(req, res, auth.createSession(credentials.sessionSecret, SESSION_TTL_MS), base(req) || '/')
    Logger.info(`Dashboard login from ${key}.`)
    res.redirect(base(req) || '/')
  })

  router.get('/logout', (req, res) => {
    clearSessionCookie(res, base(req) || '/')
    res.redirect(`${base(req)}/login`)
  })

  router.get('/status.json', requireSession, (req, res) => {
    res.json(snapshot.build(server, { flags }))
  })

  router.get('/', requireSession, (req, res) => {
    res.type('html').send(page.renderDashboard(snapshot.build(server, { flags }), {
      base: base(req),
      refreshSeconds
    }))
  })

  return router
}

/**
 * Mounts the dashboard, or does not when it is switched off.
 *
 * Kept here rather than at the call site so that turning the dashboard on and
 * off, choosing its path and reporting it at startup are all one concern in one
 * place, and index.js needs a single line.
 */
function mount (server, flags, app) {
  const settings = server.settings || {}
  const config = settings.dashboard || {}
  if (config.enabled === false) {
    Logger.info('Dashboard is switched off in settings.')
    return null
  }
  const router = createDashboard(server, flags)
  app.use(DASHBOARD_PATH, router)
  return router
}

module.exports = createDashboard
module.exports.COOKIE_NAME = COOKIE_NAME
module.exports.DASHBOARD_PATH = DASHBOARD_PATH
module.exports.SESSION_TTL_MS = SESSION_TTL_MS
module.exports.createDashboard = createDashboard
module.exports.ensureCredentials = ensureCredentials
module.exports.mount = mount
module.exports.parseCookies = parseCookies
