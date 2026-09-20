const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Point the logger at a throwaway directory and silence debug output before
 * any application module is required. Every test file must call this first:
 * logger.js resolves its log path at require time.
 */
function isolate () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiptv-test-'))
  process.env.PLEXIPTV_LOGDIR = dir
  process.env.PLEXIPTV_SETTINGS = path.join(dir, 'settings.json')
  process.env.DEBUG = 'plexiptv:nothing'
  return dir
}

module.exports = { isolate }
