const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { check, MAX_HEADER } = require('../scripts/commitlint')

const SCRIPT = path.join(__dirname, '..', 'scripts', 'commitlint.js')

test('messages from the history pass', () => {
  for (const message of [
    'fix: look for the DejaVu font where Alpine installs it',
    'feat: include ffmpeg in the Docker images, and run them as PUID:PGID',
    'ci: publish the image to Docker Hub on every release',
    'chore: release 1.6.1',
    'refactor: move the source out of the repository root into src/, and fix the credential leak CI found',
    'security: scrub credentials from ffmpeg diagnostics',
    'feat(dashboard): show the source of each channel',
    'feat!: drop the m3u8 key from settings',
    'docs: describe the published Docker image\n\nThe page doubles as the Docker Hub description.'
  ]) {
    assert.deepStrictEqual(check(message), [], message)
  }
})

test('messages git writes itself pass', () => {
  assert.deepStrictEqual(check('Merge pull request #54 from xiaodoudou/chore/release-1.6.1'), [])
  assert.deepStrictEqual(check("Merge branch 'master' into feat/dashboard"), [])
  assert.deepStrictEqual(check('Revert "feat: add a status dashboard"'), [])
})

test('a message without a type fails', () => {
  assert.strictEqual(check('Update README.md').length, 1)
  assert.strictEqual(check('fix #15, help fix the offline issue').length, 1)
  assert.strictEqual(check('Fix: capitalised type').length, 1)
  assert.strictEqual(check('fix:no space').length, 1)
})

test('an unknown type fails', () => {
  assert.match(check('feature: add a thing')[0], /not a known type/)
})

test('an empty subject, a full stop or a long header fails', () => {
  assert.match(check('fix: ')[0], /says nothing/)
  assert.match(check('fix: a sentence.')[0], /full stop/)
  assert.match(check(`fix: ${'x'.repeat(MAX_HEADER)}`)[0], /characters/)
})

test('the body must be separated from the subject', () => {
  assert.match(check('fix: a thing\nand the body straight after')[0], /blank line/)
})

test('fixup commits fail unless they come from the hook', () => {
  assert.strictEqual(check('fixup! fix: a thing').length, 1)
  assert.deepStrictEqual(check('fixup! fix: a thing', { allowAutosquash: true }), [])
})

test('the hook ignores the commented-out help git leaves in the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plexiptv-commitlint-'))
  const good = path.join(dir, 'good')
  fs.writeFileSync(good, 'fix: a thing\n\n# Please enter the commit message for your changes.\n')
  execFileSync(process.execPath, [SCRIPT, '--file', good])

  const bad = path.join(dir, 'bad')
  fs.writeFileSync(bad, 'a thing\n# Please enter the commit message for your changes.\n')
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--file', bad], { stdio: 'pipe' }))
})

test('a pull request title is checked like a subject', () => {
  execFileSync(process.execPath, [SCRIPT, '--title', 'ci: lint commit messages'])
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, '--title', 'Lint commit messages'], { stdio: 'pipe' }))
})
