require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const {
  drawTextFilters,
  escapeFontPath,
  slateArgs,
  wrap,
  writeTextFiles,
  removeTextFiles
} = require('../src/stream/slate')

test('a long message is wrapped rather than run off the screen', () => {
  const lines = wrap('the line has reached its maximum number of simultaneous connections', 30)
  assert.ok(lines.length > 1, 'it was split')
  for (const line of lines) assert.ok(line.length <= 30, `"${line}" fits`)
  assert.strictEqual(lines.join(' '), 'the line has reached its maximum number of simultaneous connections')
})

test('wrapping copes with empty and missing text', () => {
  assert.deepStrictEqual(wrap('', 20), [])
  assert.deepStrictEqual(wrap(undefined, 20), [])
  assert.deepStrictEqual(wrap('   ', 20), [])
})

test('a Windows font path is escaped so the drive letter is not read as an option', () => {
  // Without this the filter graph reads "C" as an option name and fails to
  // build, which is silent: ffmpeg still exits zero and draws nothing.
  assert.strictEqual(escapeFontPath('C:/Windows/Fonts/segoeui.ttf'), 'C\\:/Windows/Fonts/segoeui.ttf')
  assert.strictEqual(escapeFontPath('C:\\Windows\\Fonts\\arial.ttf'), 'C\\:/Windows/Fonts/arial.ttf')
  assert.strictEqual(escapeFontPath('/usr/share/fonts/DejaVuSans.ttf'), '/usr/share/fonts/DejaVuSans.ttf')
})

test('the message is passed as a file, never built into the filter graph', () => {
  const files = writeTextFiles("Cannot play 100% o'clock: News", 'the line is already in use')
  try {
    assert.ok(fs.existsSync(files.title), 'the title was written')
    assert.ok(fs.existsSync(files.detail), 'the detail was written')
    // Verbatim on disk: this is the whole point of textfile=, so that an
    // apostrophe, a colon or a percent sign cannot change what is drawn.
    assert.match(fs.readFileSync(files.title, 'utf8'), /100% o'clock: News/)

    const filters = drawTextFilters('Cannot play', 'the line is already in use', 'C:/f.ttf', files)
    assert.strictEqual(filters.length, 2, 'a title and a detail filter')
    for (const filter of filters) {
      assert.match(filter, /textfile=/, 'the words come from a file')
      assert.ok(!filter.includes("o'clock"), 'the message is not inlined into the graph')
      // drawtext expands %-sequences even when the text came from a file.
      assert.match(filter, /expansion=none/, 'expansion is switched off')
    }
  } finally {
    removeTextFiles(files)
    assert.ok(!fs.existsSync(files.dir), 'the temporary files are cleaned up')
  }
})

test('without a font the card is still produced, just without text', () => {
  assert.deepStrictEqual(drawTextFilters('Cannot play', 'a reason', null, { title: 'a.txt' }), [])
  const args = slateArgs('Cannot play', 'a reason', null, null)
  assert.ok(!args.includes('-vf'), 'no text filter is added')
  assert.strictEqual(args[args.length - 1], 'pipe:1', 'it still writes a stream')
})

test('the card is paced in real time and written as MPEG-TS', () => {
  const args = slateArgs('Cannot play', 'a reason', 'C:/f.ttf', { title: 'a.txt', detail: 'b.txt' })
  // Without -re, lavfi produces frames as fast as the CPU allows: a few
  // seconds on screen arrived as ninety megabytes before this was added.
  assert.strictEqual(args.filter((arg) => arg === '-re').length, 2, 'both inputs are paced')
  assert.strictEqual(args[args.indexOf('-f', args.indexOf('-c:a')) + 1], 'mpegts')
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'), 'silence is included')
})

test('nothing in the card reaches out to the network', () => {
  const args = slateArgs('Cannot play', 'a reason', 'C:/f.ttf', { title: 'a.txt', detail: 'b.txt' })
  for (const arg of args) {
    assert.ok(!/^https?:/.test(arg), `${arg} is not a URL`)
    assert.ok(!/^rtsp:/.test(arg), `${arg} is not a URL`)
  }
})
