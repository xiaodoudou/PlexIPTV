const { isolate } = require('./helpers')
const tmpDir = isolate()

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const Config = require('../config')

const WINDOWS = process.platform === 'win32'

test('missing settings fall back to the bundled template', async () => {
  const config = new Config()
  config.filename = path.join(tmpDir, 'absent', 'settings.json')
  const settings = await config.readSettings()
  assert.strictEqual(settings.serverPort, 1234)
  assert.ok(settings.m3u8, 'template supplies the m3u8 block')
})

test('settings are written owner-only because they carry provider credentials',
  { skip: WINDOWS ? 'POSIX file modes are not enforced on Windows' : false },
  async () => {
    const config = new Config()
    config.filename = path.join(tmpDir, 'perm', 'settings.json')
    await config.mergeWriteSettings({ serverPort: 4321 })
    const mode = fs.statSync(config.filename).mode & 0o777
    assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  })

test('an existing loosely permissioned settings file is tightened on write',
  { skip: WINDOWS ? 'POSIX file modes are not enforced on Windows' : false },
  async () => {
    const config = new Config()
    config.filename = path.join(tmpDir, 'loose-settings.json')
    fs.writeFileSync(config.filename, '{}', { mode: 0o666 })
    await config.mergeWriteSettings({ serverPort: 4321 })
    assert.strictEqual(fs.statSync(config.filename).mode & 0o777, 0o600)
  })

test('merging settings cannot pollute Object.prototype', async () => {
  const config = new Config()
  config.filename = path.join(tmpDir, 'pollute.json')
  const hostile = JSON.parse('{"__proto__": {"polluted": "yes"}, "serverPort": 1234}')
  const settings = await config.mergeWriteSettings(hostile)
  assert.strictEqual({}.polluted, undefined, 'Object.prototype must be untouched')
  assert.strictEqual(settings.serverPort, 1234)
})

test('user settings override the template but unknown keys survive', async () => {
  const config = new Config()
  config.filename = path.join(tmpDir, 'merged.json')
  const settings = await config.mergeWriteSettings({ serverPort: 9999, custom: true })
  assert.strictEqual(settings.serverPort, 9999)
  assert.strictEqual(settings.custom, true)
  assert.strictEqual(settings.serverName, 'PlexIPTV', 'template default preserved')
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(config.filename, 'utf8')), settings)
})

test('a malformed settings file is reported rather than silently ignored', async () => {
  const config = new Config()
  config.filename = path.join(tmpDir, 'broken.json')
  fs.writeFileSync(config.filename, '{ not json')
  await assert.rejects(() => config.readSettings())
})
