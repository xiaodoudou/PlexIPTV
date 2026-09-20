require('./helpers').isolate()

const test = require('node:test')
const assert = require('node:assert')
const { describeUpstreamStatus, isFatalUpstreamStatus } = require('../upstreamStatus')

test('458 is explained as the Xtream connection limit, not "Unknown Error"', () => {
  const message = describeUpstreamStatus(458)
  assert.match(message, /simultaneous connections/)
  assert.match(message, /458/)
  assert.ok(!/unknown/i.test(message))
})

test('the common provider refusals each name a cause and a remedy', () => {
  assert.match(describeUpstreamStatus(401), /credentials/)
  assert.match(describeUpstreamStatus(402), /expired|paid/)
  assert.match(describeUpstreamStatus(403), /disabled|not be allowed/)
  assert.match(describeUpstreamStatus(404), /does not exist|stream id/)
  assert.match(describeUpstreamStatus(429), /rate limiting/)
  assert.match(describeUpstreamStatus(509), /bandwidth/)
  assert.match(describeUpstreamStatus(512), /banned|disabled/)
})

test('unmapped statuses still produce a sentence rather than a bare code', () => {
  assert.match(describeUpstreamStatus(503), /server error/)
  assert.match(describeUpstreamStatus(418), /refused the request/)
  assert.match(describeUpstreamStatus(302), /redirect/)
  assert.match(describeUpstreamStatus(200), /unexpected status/)
})

test('a status given as a string is handled', () => {
  assert.strictEqual(describeUpstreamStatus('458'), describeUpstreamStatus(458))
})

test('only 4xx counts as fatal, so 5xx and network errors still retry', () => {
  for (const code of [400, 401, 403, 404, 458, 499]) {
    assert.strictEqual(isFatalUpstreamStatus(code), true, `${code} should be fatal`)
  }
  for (const code of [200, 302, 500, 502, 503, 509, 512]) {
    assert.strictEqual(isFatalUpstreamStatus(code), false, `${code} should be retryable`)
  }
})
