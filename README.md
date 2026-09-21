<div align="center">

# PlexIPTV

> An IPTV subscription as live TV in Plex, by pretending to be an HDHomeRun tuner

![GitHub Release](https://img.shields.io/github/v/release/xiaodoudou/PlexIPTV?style=flat-square&color=e94560)
![License](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)
![GitHub Stars](https://img.shields.io/github/stars/xiaodoudou/PlexIPTV?style=flat-square&color=yellow)
![Node](https://img.shields.io/badge/Node-%3E%3D22-339933?style=flat-square)
![Docker Pulls](https://img.shields.io/docker/pulls/xiaodoudoufr/plexiptv?style=flat-square&color=2496ed)
![Streams](https://img.shields.io/badge/Streams-MPEG--TS%20%7C%20HLS%20%7C%20RTSP-blueviolet?style=flat-square)

This app simulates a DVR device for Plex, so an IPTV subscription shows up as live TV. Point it at
an m3u playlist or at an Xtream account and Plex sees an HDHomeRun tuner.

</div>

---

I created that app for several reaons:
- Other existing projects where too much complexe for my use (tvhProxy: https://github.com/jkaberg/tvhProxy)
- Not enougth flexible for my use (telly: https://github.com/tombowditch/telly)
- None of the existing projects where pulling a remote playlist

___

Raw MPEG-TS, HLS and RTSP streams all play. See
[Streams and formats](#streams-and-formats) for what happens to each, and
[Xtream accounts](#xtream-accounts) if your provider gave you a login rather
than a playlist URL.

## What it does?
- takes an m3u playlist URL or an Xtream username and password
- caches the playlist locally and falls back to it when the provider is down
- filters, renames and renumbers channels so Plex sees the lineup you want
- proxies the stream, so the provider only ever sees one viewer: the server
- lets several people watch the same channel on a line that allows one
- plays HLS and RTSP as well as raw MPEG-TS, repackaging where needed
- serves an XMLTV guide with your channel logos and programme listings

## Downloads
You can download the last version on the [release page](https://github.com/xiaodoudou/PlexIPTV/releases)

## OS
This app has been tested on windows, however it should work for all systems. If any isuse encounter, feel freel to create an issue.

Please provide me the full logs of what is happenning by doing on:

- Linux
```bash
DEBUG=* ./PlexIPTV.linux-x64
```
- MacOS
```bash
DEBUG=* ./PlexIPTV.macos.x64
```
- Windows
```powershell
set DEBUG=* & PlexIPTV.win.x64.exe & set debug =
```

## Xtream accounts

If your provider gives you a username, a password and a server address, you can
use those directly instead of a playlist URL:

```javascript
{
  "xtream": {
    "url": "http://line.your-provider.tv",
    "username": "your-username",
    "password": "your-password",
    "output": "ts"          // "ts" for a raw transport stream, "m3u8" for HLS
  }
}
```

That is all that is needed. The channel list, the logos, the guide ids and the
group names all come from the provider's API, and the guide URL is the one that
belongs to the account rather than something inferred.

It also checks the account before doing anything else and tells you what the
provider said, so an expired or suspended line reports itself instead of
turning up as an empty channel list:

```
Xtream account is Active, using 0/1 connections.
Xtream catalogue: 55406 live streams.
```

Filters, renaming, channel numbers and the limit all behave exactly as they do
for a playlist, because the catalogue is turned into one internally. `m3u8.local`
is still used, as the cache to fall back on if the provider is unreachable on a
later start.

Set `m3u8.remote` instead if you have a playlist URL. If both are present, the
Xtream account wins.

## Settings

Your `settings.json` contains your provider URL, which for most providers
embeds your username and password. It is written with `0600` permissions, and
it is in `.gitignore`, keep it that way.

```javascript
{
  "xtream": {          // Optional. Use these instead of m3u8.remote if you have them
    "url": "",         // e.g. "http://line.your-provider.tv"
    "username": "",
    "password": "",
    "output": "ts"     // "ts" or "m3u8"
  },
  "m3u8": {
    "local": "iptv.m3u8", // Locale file, also the cache for an Xtream account
    "remote": "https://domain.fqd/blablabla.m3u8" // Remote URL of the playlist
  },
  "serverPort": 1234, // Server port
  "serverHost": "0.0.0.0", // Interface to bind. See the security note below
  "serverName": "PlexIPTV", // Name of the server
  "publicUrl": "", // Optional. Pins the URL advertised to Plex, e.g. "http://192.168.1.10:1234".
                   // When empty the client supplied Host header is used instead
  "allowPrivateNetwork": false, // Allow streams on private/LAN addresses. See the security note below
  "epgUrl": "", // Optional. XMLTV guide to merge into /xmltv.xml. Worked out from
                // the playlist URL automatically for Xtream providers
  "tunerCount": 1, // How many simultaneous feed your IPTV provider support
  "limit": -1, // Maximum number of channels to expose, -1 for no limit
  "removeIfNotFoundOnFilter": true, // Will remove channel from playlist that aren't present on the filter list
  "doNotPullRemotePlaylist": false, // Will not pul online playlist
  "filter": [ // Filter list
    {
      "name": ">>> US News", // Regex of the name to match on the playlist
      "channel": "1" // Channel that will use for the found matching channel name
    },
    {
      "name": ">>> World News",
      "rename": "World News", // Will rename the channel to "World News"
      "channel": "2"
    },
    {
      "meta": "I254\\.59337\\.schedulesdirect\\.org", // Will map channel if the meta tag contain I254.59337.schedulesdirect.org
      "channel": "3"
    },
    {
      "name": ">>> Cartoons", // Will map channel if name contains ">>> Cartoons" and ...
      "meta": "I251\\.59331\\.schedulesdirect\\.org", // if the meta tag contain I251.59331.schedulesdirect.org
      "channel": "4"
    },
  ]
}
```

### How filters behave

**`name` and `meta` are regular expressions, not plain text.** Characters that
are punctuation to a regex have to be escaped, and in JSON the backslash itself
has to be doubled:

| To match | Write |
| --- | --- |
| `TVA (FR)` | `"name": "TVA \\(FR\\)"` |
| `Canal+` | `"name": "Canal\\+"` |
| `Sky Sports F1` | `"name": "Sky Sports F1"` (nothing to escape) |

Unescaped, `Canal+` means "Cana" followed by one or more `l`, and `TVA (FR)`
matches `TVA FR` without the brackets, which is why those filters appear to do
nothing. An invalid pattern is reported in the log and skipped rather than
taking the server down.

A filter that matches no channels is reported at startup, with the escaped
pattern to copy if that is what went wrong:

```
Filter #1 (name "Canal + 1 HD PL") matched no channels. Patterns are regular
expressions, so if you meant that literally, write it as "Canal \+ 1 HD PL".
```

**A filter that matches several channels numbers them consecutively** from its
`channel`. A filter of `"name": "^UK:"` with `"channel": "100"` gives the first
match 100, the next 101, and so on. Plex keeps only one channel per number, so
without this a whole group would collapse into a single entry.

**Omit `channel`** and matching channels are auto-numbered from 80000 instead.

**Filter a whole group** through `meta`, which is matched against the entire
`#EXTINF` line, including `group-title`:

```javascript
{ "meta": "group-title=\"FRENCH\"", "channel": "1" }
```

**When both `name` and `meta` are given, both must match.** A filter that sets
neither is ignored, since it would otherwise claim every channel.

## Streams and formats

Plex expects an HDHomeRun tuner to deliver a continuous MPEG-TS stream. What a
provider actually serves varies, and PlexIPTV now handles each case:

| The provider serves | What happens |
| --- | --- |
| Raw MPEG-TS (`.ts`) | Forwarded byte for byte. |
| HLS with TS segments (`.m3u8` → `.ts`) | The playlist is followed and its segments are joined into one stream. No transcoding: HLS TS segments already *are* MPEG-TS. |
| HLS with fragmented MP4 segments (`.m3u8` → `.m4s`) | Repackaged with ffmpeg using `-c copy`. Audio and video are **not** re-encoded, so the cost is small and quality is untouched. Requires ffmpeg. |
| RTSP (`rtsp://`, `rtsps://`) | Played through ffmpeg with `-c copy`, again without re-encoding. Common on ISP boxes such as Freebox. Requires ffmpeg. |
| An error page with a `200` status | Reported as a `502` naming the reason, instead of being handed to Plex as if it were video. |

A live HLS stream is joined at the **live edge** rather than from the start of
the playlist window, so a channel does not begin half a minute in the past.

### ffmpeg

ffmpeg is optional. It is needed for two cases: fragmented-MP4 HLS segments,
which are uncommon, and RTSP channels. Without it those channels report a clear
message instead of failing silently, and everything else is unaffected. Put
`ffmpeg` on `PATH`, or point `PLEXIPTV_FFMPEG` at the binary. Set
`PLEXIPTV_FFMPEG=none` to refuse to start it at all.

For HLS, segments are downloaded by PlexIPTV and piped into ffmpeg over stdin,
so ffmpeg never opens a network connection of its own.

RTSP is the exception, because this process does not speak it. There ffmpeg
opens the connection, so the URL is validated first, in the same way as any
other channel, and ffmpeg is restricted with `-protocol_whitelist` to RTSP and
its transports. `file` is deliberately excluded, so a hostile session
description cannot make it read from disk. A source that accepts the connection
and then sends nothing is given up on after 15 seconds rather than holding the
channel open.

Most ISP boxes serving RTSP are on your LAN, so those channels also need
`"allowPrivateNetwork": true`.

## Channel logos and the guide

Channel logos cannot travel through the tuner. PlexIPTV presents itself to Plex
as an HDHomeRun device, and that lineup format has three fields per channel:
number, name and URL. There is nowhere to put an image.

They travel through the **guide** instead, so PlexIPTV serves one:

```
http://your-server:1234/xmltv.xml
```

Add that as the XMLTV guide when you set up the DVR in Plex. It contains your
channels, numbered and named exactly as the tuner presents them, with the
`tvg-logo` from your playlist attached to each.

If your provider publishes an XMLTV feed, programme data is merged in as well.
For an Xtream provider the URL is worked out from your playlist URL
automatically, by swapping `get.php` for `xmltv.php`. Set `epgUrl` in the
settings to point somewhere else, or to use a guide from a provider that does
not follow that convention.

Only programmes for channels in your lineup are kept, and their channel ids are
rewritten to your channel numbers. That matters for two reasons: pointing Plex
straight at a provider guide stops working the moment you rename or renumber
anything with filters, and a provider guide covering their whole catalogue runs
to tens of megabytes where a filtered lineup needs well under a megabyte.

**None of this is required.** No guide URL, an unreachable one, or a provider
without an EPG all produce the same thing: the channel list with its logos,
served immediately. You lose programme listings and nothing else.

One thing worth knowing: logos served over plain `http` do not appear when you
use Plex through `app.plex.tv`, because the browser refuses to load insecure
images into a secure page. They show up in the local web app and in the native
clients.

## Security

Two points matter when you deploy:

**The server has no authentication.** It binds `0.0.0.0` by default so Plex can
discover it on your LAN, which means anyone who can reach the port can list and
stream every channel using your subscription. Keep it on a trusted network, or
set `"serverHost"` to a specific interface. Do not port-forward it.

**Streams pointing at private addresses are refused by default.** Only `http`
and `https` URLs are fetched, and addresses in private, loopback, link-local
and reserved ranges are rejected so a hostile or tampered playlist cannot turn
the proxy into a probe against your internal network. If you genuinely stream
from a LAN source, set `"allowPrivateNetwork": true`.

## Docker
You can pull the image by doing `docker pull xiaodoudoufr/plexiptv`, then you can run it by `docker run -p 12345:1234 --volume [your config path]:/opt/PlexIPTV/config -d xiaodoudoufr/plexiptv`

The images run as the unprivileged `node` user and install runtime dependencies
only.

## TODO:
- [x] Option to avoid pulling online playlist
- [x] Docker container
- [x] Resolving nesting playlist (HLS)
- [x] Xtream account support
- [x] RTSP channels
- [x] Channel logos and an XMLTV guide
- [ ] Merge multiples online playlist

## How to build yourself the app?
Requires Node.js 22 or newer. After running `npm install`, `npm run build`
produces standalone binaries in `build/`:

| Target | Script |
| --- | --- |
| Windows x64 | `npm run build:win:x64` |
| macOS x64 | `npm run build:macos:x64` |
| Linux x64 | `npm run build:linux:x64` |
| Linux arm64 | `npm run build:linux:arm64` |
| macOS arm64 | `npm run build:macos:arm64` (not in `npm run build`, see below) |

The binaries bundle Node 26 and are produced with
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg), the maintained fork of the
archived `vercel/pkg`. The original `pkg` only supported up to Node 18, which
is end of life, and carried an unpatched privilege-escalation advisory.

Two cross-compilation caveats:

- **arm64 targets are built without V8 bytecode** (`--no-bytecode --public`).
  Generating bytecode requires *executing* the target binary, which an x64 host
  cannot do for arm64. The source is therefore readable inside those binaries.
- **macOS arm64 is excluded from `npm run build`.** Apple Silicon refuses to
  launch an unsigned binary, and signing cannot be done from Windows or Linux
  without `ldid`. Build it, then on a Mac run
  `codesign --sign - PlexIPTV.macos.arm64`.

Dependencies are locked with `package-lock.json`; the old `yarn.lock` was
dropped so there is a single lockfile.

## Tests
```bash
npm test
```

Runs the suite with the built-in Node test runner, no test framework
dependency. `npm run lint` checks style, and `npm run audit:prod` audits the
dependencies that actually ship.


## Changelogs
```
current work in progress:
 - online playlist merging
 - investigating why buffer is failing on some specific IPTV vendor

1.5.0:
 - an Xtream account can be configured with its url, username and password
   instead of a playlist URL. Channels, logos, guide ids and group names all
   come from the provider API, and the guide URL belongs to the account rather
   than being inferred
 - the account is checked at startup, so an expired or suspended line says so
   instead of appearing as an empty channel list
 - the provider's connection count is reported at startup
 - a channel name containing a line break can no longer inject an extra entry
   into the generated playlist

1.4.0:
 - serves an XMLTV guide at /xmltv.xml carrying the tvg-logo from your
   playlist, which is the only route by which a channel logo can reach Plex (#28)
 - merges provider programme data into it when there is any, keeping only the
   channels in your lineup and renumbering them to match
 - the guide URL is derived from an Xtream playlist URL automatically, or set
   "epgUrl" yourself
 - no guide, a broken guide or a slow one costs you programme listings and
   nothing else: the channels and their logos are served either way

1.3.1:
 - a filter that matches no channels now says so at startup, and offers the
   escaped pattern when the cause is an unescaped regex character. Four
   separate reports turned out to be this (#21, #22, #23, #27)

1.3.0:
 - RTSP channels (rtsp:// and rtsps://) now play, through ffmpeg with -c copy
   so nothing is re-encoded. Common on ISP boxes such as Freebox (#32)
 - an RTSP source that accepts the connection and then sends nothing is given
   up on after 15 seconds instead of holding the channel open
 - replaced node-ssdp with a small built-in SSDP responder. It was the last
   package pulling in a dependency with an unfixable advisory, and npm audit
   now reports zero vulnerabilities
 - discovery now degrades with a warning when port 1900 is already taken,
   rather than failing with an unhandled socket error
 - stream failures name the channel in the log rather than an internal URL

1.2.1:
 - fix: the upstream is now held open for a few seconds after the last viewer
   leaves, so a reconnecting player rejoins the running stream instead of
   restarting it. Restarting made the provider replay from the head of its
   buffer, which showed up as the channel looping back ten seconds, and on a
   one-connection line it also burned the only slot (#30)
 - fix: scan progress was a fraction floored to an integer, so it read 0%
   until the very last channel
 - fix: discover.json reported the model name in the ModelNumber field

1.2.0:
 - HLS (m3u8) streams are now supported: the playlist is followed and its
   segments are served to Plex as a continuous MPEG-TS stream (#8)
 - fragmented MP4 HLS segments are repackaged with ffmpeg (-c copy, no
   re-encoding); ffmpeg is optional and only needed for that case
 - a provider that answers with an error page and a 200 status is reported as
   a 502 naming the reason, instead of being streamed to Plex as if it were
   video (this is what "Unable to tune channel" usually was)
 - live HLS streams are joined at the live edge rather than replaying the
   playlist window

1.1.1:
 - fix: a filter matching several channels now numbers them consecutively
   instead of giving them all the same number (#21)
 - fix: a filter with no "channel" auto-numbers instead of producing the
   literal channel "undefined" (#21)
 - fix: a filter setting both "name" and "meta" never matched anything, so the
   combined form the README documents (and template.json ships) did not work
 - fix: a filter setting neither "name" nor "meta" claimed every channel; it is
   now ignored with a warning
 - docs: spell out that filters are regular expressions and need escaping (#27)

1.1.0:
 - security: stop writing provider credentials to the log file, settings and playlist cache
 - security: only fetch http/https URLs, and refuse private/loopback addresses by default
 - security: escape all values interpolated into device.xml
 - security: return 404 instead of faulting on an unknown channel id
 - security: drop request, lodash, moment, filendir and valid-url; upgrade the rest
 - security: Docker images run as a non-root user on Node 22 LTS
 - requires Node.js 18 or newer
 - adds a test suite (npm test)
 - BREAKING: streams on private/LAN addresses are now refused unless you set
   "allowPrivateNetwork": true in your settings
 
1.0.4:  
 - fix settings / template merging
 - add rename feature
 - add meta filtering

1.0.3:
 - allow config file path to be changed `--settings [path/file.json`
 - allow log path to be change through param `--logdir [path]`
 - add helper if app is called with `--help`
 - allow docker container to mount volume againts `/opt/PlexIPTV/config` to preserve config
 
1.0.2:
 - fix bug related to channel number was given as a int and not a string (require by plex)
 
1.0.1:
 - add option to avoid pulling online playlist
 - add a docker container

1.0.0:
 - first release

```
