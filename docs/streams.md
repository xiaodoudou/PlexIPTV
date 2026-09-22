# Streams and formats

What happens to MPEG-TS, HLS and RTSP, and where ffmpeg is needed.

Plex expects an HDHomeRun tuner to deliver a continuous MPEG-TS stream. What a provider actually serves varies, and PlexIPTV now handles each case:

| The provider serves | What happens |
| --- | --- |
| Raw MPEG-TS (`.ts`) | Forwarded byte for byte. |
| HLS with TS segments (`.m3u8` → `.ts`) | The playlist is followed and its segments are joined into one stream. No transcoding: HLS TS segments already *are* MPEG-TS. |
| HLS with fragmented MP4 segments (`.m3u8` → `.m4s`) | Repackaged with ffmpeg using `-c copy`. Audio and video are **not** re-encoded, so the cost is small and quality is untouched. Requires ffmpeg. |
| RTSP (`rtsp://`, `rtsps://`) | Played through ffmpeg with `-c copy`, again without re-encoding. Common on ISP boxes such as Freebox. Requires ffmpeg. |
| An error page with a `200` status | Reported as a `502` naming the reason, instead of being handed to Plex as if it were video. |

A live HLS stream is joined at the **live edge** rather than from the start of the playlist window, so a channel does not begin half a minute in the past.

### ffmpeg

ffmpeg is optional. It is needed for two cases: fragmented-MP4 HLS segments, which are uncommon, and RTSP channels. Without it those channels report a clear message instead of failing silently, and everything else is unaffected. Put `ffmpeg` on `PATH`, or point `PLEXIPTV_FFMPEG` at the binary. Set `PLEXIPTV_FFMPEG=none` to refuse to start it at all.

For HLS, segments are downloaded by PlexIPTV and piped into ffmpeg over stdin, so ffmpeg never opens a network connection of its own.

RTSP is the exception, because this process does not speak it. There ffmpeg opens the connection, so the URL is validated first, in the same way as any other channel, and ffmpeg is restricted with `-protocol_whitelist` to RTSP and its transports. `file` is deliberately excluded, so a hostile session description cannot make it read from disk. A source that accepts the connection and then sends nothing is given up on after 15 seconds rather than holding the channel open.

Most ISP boxes serving RTSP are on your LAN, so those channels also need `"allowPrivateNetwork": true`.
