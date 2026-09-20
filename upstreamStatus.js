/**
 * Turns the status an IPTV provider returns into something a human can act on.
 *
 * Xtream Codes panels reuse a handful of non-standard codes (458 in
 * particular is not an HTTP status at all), so a bare "Unknown Error (458)"
 * tells the operator nothing. These messages name the likely cause and the
 * thing to try.
 */

const MESSAGES = {
  400: 'the provider rejected the request as malformed (400). The stream URL in the playlist may be wrong.',
  401: 'the provider rejected the credentials (401). Check the username and password in your playlist URL.',
  402: 'the subscription is not paid or has expired (402). Renew the line with your provider.',
  403: 'the provider refused access (403). The line may be disabled, or your IP or user agent may not be allowed.',
  404: 'the channel does not exist on the provider (404). The stream id has probably changed, so re-pull the playlist.',
  429: 'the provider is rate limiting this line (429). Wait before reconnecting.',
  // Xtream Codes specific.
  458: 'the line has reached its maximum number of simultaneous connections (458). Close any other player using it, or ask your provider for more connections.',
  509: 'the provider reports the bandwidth limit was exceeded (509).',
  512: 'the provider reports this line is banned or disabled (512).'
}

/**
 * @param {number} status
 * @returns {string} A sentence describing the status.
 */
function describeUpstreamStatus (status) {
  const code = Number(status)
  if (MESSAGES[code]) return MESSAGES[code]
  if (code >= 500) return `the provider had a server error (HTTP ${code}). This is usually temporary.`
  if (code >= 400) return `the provider refused the request (HTTP ${code}).`
  if (code >= 300) return `the provider returned an unexpected redirect (HTTP ${code}).`
  return `the provider returned an unexpected status (HTTP ${code}).`
}

/**
 * True when the status means retrying is pointless: the provider is
 * deliberately refusing, so reconnecting only risks the account.
 */
function isFatalUpstreamStatus (status) {
  const code = Number(status)
  return code >= 400 && code < 500
}

module.exports = { MESSAGES, describeUpstreamStatus, isFatalUpstreamStatus }
