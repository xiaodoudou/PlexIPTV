/**
 * What the provider actually sent back.
 *
 * A stream URL returning HTTP 200 does not mean it returned video. Providers
 * routinely answer with a plain text or HTML error page and a 200 status
 * ("FAILED TO CONNECT" is a common one), and the proxy used to forward that
 * straight to Plex, which reports it as "Unable to tune channel" with nothing
 * to go on. Others answer with an HLS manifest rather than a transport
 * stream, which Plex cannot play either.
 */

// Every MPEG-TS packet starts with 0x47 and they are 188 bytes apart.
const TS_SYNC_BYTE = 0x47
const TS_PACKET_SIZE = 188

function looksLikeTransportStream (chunk) {
  if (!chunk || chunk.length === 0) return false
  if (chunk[0] !== TS_SYNC_BYTE) return false
  // One sync byte could be coincidence; check the next packet boundary too
  // when the chunk is long enough to contain it.
  if (chunk.length > TS_PACKET_SIZE) {
    return chunk[TS_PACKET_SIZE] === TS_SYNC_BYTE
  }
  return true
}

function looksLikeManifest (chunk) {
  if (!chunk || chunk.length === 0) return false
  // trimStart() also removes a UTF-8 BOM, which some providers emit ahead of
  // #EXTM3U, because U+FEFF counts as whitespace in JavaScript.
  return chunk.slice(0, 512).toString('utf8').trimStart().startsWith('#EXTM3U')
}

/**
 * @returns {'mpegts'|'hls'|'other'}
 */
function detectPayload (contentType, chunk) {
  const type = String(contentType || '').toLowerCase()

  // The body is more trustworthy than the header: providers mislabel both
  // directions, and an error page served as video/mp2t is common.
  if (looksLikeTransportStream(chunk)) return 'mpegts'
  if (looksLikeManifest(chunk)) return 'hls'

  if (type.includes('mpegurl')) return 'hls'
  if (type.includes('mp2t') || type.includes('video/') || type.includes('octet-stream')) return 'mpegts'
  return 'other'
}

/**
 * Turns a provider's error page into one readable line for the log and for the
 * 502 the client receives.
 */
function describePayload (contentType, chunk) {
  const text = chunk
    ? chunk.slice(0, 512).toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  if (text.length > 0) {
    const snippet = text.length > 160 ? `${text.slice(0, 160)}...` : text
    return `the provider returned a message instead of video: "${snippet}"`
  }
  return `the provider returned ${contentType || 'an unknown content type'} instead of a video stream`
}

module.exports = {
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
  describePayload,
  detectPayload,
  looksLikeManifest,
  looksLikeTransportStream
}
