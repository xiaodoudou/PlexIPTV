# PlexIPTV
This app simulate a DVR device for Plex by providing a layer to any IPTV provider (that provide a m3u8 playlist).

I created that app for several reaons:
- Other existing projects where too much complexe for my use (tvhProxy: https://github.com/jkaberg/tvhProxy)
- Not enougth flexible for my use (telly: https://github.com/tombowditch/telly)
- None of the existing projects where pulling a remote playlist

___

Note that currently it seems only MPEG2 TS stream playlist are supported (which is cover by any xtream code providers).

If your provider is doing nested playlist, it will result an error message from Plex saying "Unable to tune channel".

## What it does?
It does:
- pull remote m3u8 file to a local file
- if remote file isn't accessible it will fallback to the local file
- settings can help to filter play list and remap the channels
- proxy the IPTV stream so only the server will be seen as the "user"
- allow multiple concurent views into the same channel even if the provider block it

## Downloads
You can download the last version on the [release page](https://github.com/xiaodoudou/PlexIPTV/releases)

## OS
This app has been tested on windows, however it should work for all systems. If any isuse encounter, feel freel to create an issue.

Please provide me the full logs of what is happenning by doing on:

- Linux
```bash
DEBUG=* ./PlexIPTV.linux.x64
```
- MacOS
```bash
DEBUG=* ./PlexIPTV.macos.x64
```
- Windows
```powershell
set DEBUG=* & PlexIPTV.win.x64.exe & set debug =
```

## Settings

Your `settings.json` contains your provider URL, which for most providers
embeds your username and password. It is written with `0600` permissions, and
it is in `.gitignore` — keep it that way.

```javascript
{
  "m3u8": {
    "local": "iptv.m3u8", // Locale file
    "remote": "https://domain.fqd/blablabla.m3u8" // Remote URL of the playlist
  },
  "serverPort": 1234, // Server port
  "serverHost": "0.0.0.0", // Interface to bind. See the security note below
  "serverName": "PlexIPTV", // Name of the server
  "publicUrl": "", // Optional. Pins the URL advertised to Plex, e.g. "http://192.168.1.10:1234".
                   // When empty the client supplied Host header is used instead
  "allowPrivateNetwork": false, // Allow streams on private/LAN addresses. See the security note below
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
matches `TVA FR` without the brackets — which is why those filters appear to do
nothing. An invalid pattern is reported in the log and skipped rather than
taking the server down.

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
- [ ] Merge multiples online playlist
- [ ] Resolving nesting playlist

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

Runs the suite with the built-in Node test runner — no test framework
dependency. `npm run lint` checks style, and `npm run audit:prod` audits the
dependencies that actually ship.


## Changelogs
```
current work in progress:
 - online playlist merging
 - investigating why buffer is failing on some specific IPTV vendor

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
