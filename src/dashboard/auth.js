const crypto = require('crypto')

// scrypt parameters. N=16384 puts a single verification in the tens of
// milliseconds on the hardware this runs on: slow enough to make an offline
// guessing run expensive, fast enough that a login does not feel stuck.
// Memory use is 128 * N * r, about 16MB, which stays under node's 32MB default.
const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const SCHEME = 'scrypt'

// Ambiguous characters are left out: a password read off a terminal and typed
// into a browser should not hinge on telling l from 1 or O from 0.
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ2345679'
const GENERATED_PASSWORD_LENGTH = 20

const SESSION_SECRET_BYTES = 32

/**
 * Derives a storable verifier. The plaintext is never part of the result, so
 * the settings file only ever holds something that can check a password, not
 * something that can reproduce one.
 */
function hashPassword (plain) {
  const salt = crypto.randomBytes(SALT_LENGTH)
  const key = crypto.scryptSync(plain, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return [SCHEME, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$')
}

/**
 * Checks a password against a stored verifier.
 *
 * The parameters are read back out of the stored string rather than assumed, so
 * a verifier written by an older build with different costs still validates.
 */
function verifyPassword (plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== SCHEME) return false

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false

  let salt
  let expected
  try {
    salt = Buffer.from(parts[4], 'base64')
    expected = Buffer.from(parts[5], 'base64')
  } catch (error) {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  let actual
  try {
    actual = crypto.scryptSync(plain, salt, expected.length, { N, r, p })
  } catch (error) {
    // Malformed or hostile cost parameters: a failure to derive is a failure to
    // authenticate, never an exception out of the request handler.
    return false
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function generatePassword () {
  const bytes = crypto.randomBytes(GENERATED_PASSWORD_LENGTH)
  let out = ''
  for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]
  return out
}

function generateSessionSecret () {
  return crypto.randomBytes(SESSION_SECRET_BYTES).toString('base64')
}

function sign (secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

/**
 * A session is its own expiry plus a signature over it. Nothing is kept server
 * side, so a restart invalidates every session, which for a status page is the
 * right trade: no state to leak and no store to keep.
 */
function createSession (secret, ttlMs) {
  const payload = Buffer.from(String(Date.now() + ttlMs)).toString('base64url')
  return `${payload}.${sign(secret, payload)}`
}

function verifySession (secret, token) {
  if (typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const payload = token.slice(0, dot)
  const provided = Buffer.from(token.slice(dot + 1))
  const expected = Buffer.from(sign(secret, payload))
  // Compare before parsing: an attacker should learn nothing from how long a
  // rejection takes, and an unsigned payload is not worth reading.
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return false
  const expiresAt = Number(Buffer.from(payload, 'base64url').toString())
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

/**
 * Counts failed attempts per client address over a sliding window.
 *
 * The dashboard password is the only thing between a visitor and the channel
 * list, so an unthrottled login form is an invitation to guess.
 */
class LoginLimiter {
  constructor (options) {
    const config = options || {}
    this.max = config.max != null ? config.max : 10
    this.windowMs = config.windowMs != null ? config.windowMs : 15 * 60 * 1000
    this.attempts = new Map()
  }

  _prune (now) {
    for (const [key, times] of this.attempts) {
      const recent = times.filter((time) => now - time < this.windowMs)
      if (recent.length === 0) this.attempts.delete(key)
      else this.attempts.set(key, recent)
    }
  }

  isBlocked (key, now) {
    const at = now != null ? now : Date.now()
    this._prune(at)
    const times = this.attempts.get(key) || []
    return times.length >= this.max
  }

  recordFailure (key, now) {
    const at = now != null ? now : Date.now()
    const times = this.attempts.get(key) || []
    times.push(at)
    this.attempts.set(key, times)
    this._prune(at)
  }

  reset (key) {
    this.attempts.delete(key)
  }

  retryAfterSeconds (key, now) {
    const at = now != null ? now : Date.now()
    const times = this.attempts.get(key) || []
    if (times.length === 0) return 0
    const oldest = Math.min.apply(null, times)
    return Math.max(0, Math.ceil((this.windowMs - (at - oldest)) / 1000))
  }
}

module.exports = {
  SCHEME,
  hashPassword,
  verifyPassword,
  generatePassword,
  generateSessionSecret,
  createSession,
  verifySession,
  LoginLimiter
}
