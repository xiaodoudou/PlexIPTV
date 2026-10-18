#!/usr/bin/env node
'use strict'

// Checks commit messages and pull request titles against the format the
// history already follows: "type: what changed", or "type(scope): ...".
//
//   node scripts/commitlint.js                  commits on this branch not on origin/master
//   node scripts/commitlint.js base..head       commits in a range
//   node scripts/commitlint.js --title "..."    a pull request title
//   node scripts/commitlint.js --file <path>    a message file, as a commit-msg hook gets it
//
// Options combine: CI passes a range and the title in one call.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')

const TYPES = ['feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'security', 'ci', 'build', 'chore', 'style', 'revert']

// The longest title merged so far is exactly this long.
const MAX_HEADER = 100

const HEADER = /^([a-z]+)(\([a-z0-9][a-z0-9._/-]*\))?(!)?: (.*)$/

/**
 * Returns what is wrong with one message, as a list of sentences. Empty means
 * it passes. Only a commit-msg hook should pass allowAutosquash: a fixup!
 * commit is fine while working, but should be squashed before it is pushed.
 */
function check (message, { allowAutosquash = false } = {}) {
  const lines = message.replace(/\r\n/g, '\n').split('\n')
  const header = lines[0]
  const problems = []

  // Messages git writes itself.
  if (/^Merge (branch|pull request|remote-tracking branch) /.test(header)) return problems
  if (/^Revert ".*"$/.test(header)) return problems
  if (/^(fixup|squash|amend)! /.test(header)) {
    if (!allowAutosquash) problems.push(`"${header}" should be squashed into the commit it fixes before merging`)
    return problems
  }

  const match = HEADER.exec(header)
  if (!match) {
    problems.push(`"${header}" should start with a type, as in "fix: ..." or "feat(dashboard): ...". Types: ${TYPES.join(', ')}`)
    return problems
  }

  const [, type, , , subject] = match
  if (!TYPES.includes(type)) {
    problems.push(`"${type}" is not a known type. Use one of: ${TYPES.join(', ')}`)
  }
  if (!subject.trim()) {
    problems.push(`"${header}" says nothing after the type`)
  } else if (subject !== subject.trim()) {
    problems.push(`"${header}" has stray spaces around its subject`)
  }
  if (subject.endsWith('.')) {
    problems.push(`"${header}" should not end with a full stop`)
  }
  if (header.length > MAX_HEADER) {
    problems.push(`"${header}" is ${header.length} characters, more than ${MAX_HEADER}`)
  }
  if (lines.length > 1 && lines[1].trim() !== '') {
    problems.push(`"${header}" needs a blank line between the subject and the body`)
  }
  return problems
}

/** Commits in a range, oldest first, without merge commits. */
function commitsIn (range) {
  const out = execFileSync('git', ['log', '--no-merges', '--reverse', '--format=%H%x00%B%x00', range], { encoding: 'utf8' })
  const parts = out.split('\0')
  const commits = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    commits.push({ sha: parts[i].trim(), message: parts[i + 1].trim() })
  }
  return commits
}

function main (argv) {
  const subjects = []
  let ranges = []
  let fromHook = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--title') {
      subjects.push({ label: 'pull request title', message: argv[++i] || '' })
    } else if (argv[i] === '--file') {
      // Git leaves the commented-out help text in the file for the hook.
      const message = fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/).filter(line => !line.startsWith('#')).join('\n').trim()
      subjects.push({ label: 'commit message', message })
      fromHook = true
    } else {
      ranges.push(argv[i])
    }
  }
  if (!subjects.length && !ranges.length) ranges = ['origin/master..HEAD']

  for (const range of ranges) {
    for (const commit of commitsIn(range)) {
      subjects.push({ label: commit.sha.slice(0, 7), message: commit.message })
    }
  }

  let failed = 0
  for (const { label, message } of subjects) {
    const problems = check(message, { allowAutosquash: fromHook })
    if (!problems.length) continue
    failed++
    for (const problem of problems) {
      console.error(process.env.GITHUB_ACTIONS ? `::error title=${label}::${problem}` : `${label}: ${problem}`)
    }
  }

  if (failed) {
    console.error(`\n${failed} of ${subjects.length} failed. The format is described in docs/building.md.`)
    return 1
  }
  if (!fromHook) console.log(`${subjects.length} checked, all fine.`)
  return 0
}

if (require.main === module) process.exitCode = main(process.argv.slice(2))

module.exports = { check, TYPES, MAX_HEADER }
