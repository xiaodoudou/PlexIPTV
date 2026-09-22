# Settings

Every key in `settings.json`, and how filters behave.

Your `settings.json` contains your provider URL, which for most providers embeds your username and password. It is written with `0600` permissions, and it is in `.gitignore`, keep it that way.

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

## How filters behave

**`name` and `meta` are regular expressions, not plain text.** Characters that are punctuation to a regex have to be escaped, and in JSON the backslash itself has to be doubled:

| To match | Write |
| --- | --- |
| `TVA (FR)` | `"name": "TVA \\(FR\\)"` |
| `Canal+` | `"name": "Canal\\+"` |
| `Sky Sports F1` | `"name": "Sky Sports F1"` (nothing to escape) |

Unescaped, `Canal+` means "Cana" followed by one or more `l`, and `TVA (FR)` matches `TVA FR` without the brackets, which is why those filters appear to do nothing. An invalid pattern is reported in the log and skipped rather than taking the server down.

A filter that matches no channels is reported at startup, with the escaped pattern to copy if that is what went wrong:

```
Filter #1 (name "Canal + 1 HD PL") matched no channels. Patterns are regular
expressions, so if you meant that literally, write it as "Canal \+ 1 HD PL".
```

**A filter that matches several channels numbers them consecutively** from its `channel`. A filter of `"name": "^UK:"` with `"channel": "100"` gives the first match 100, the next 101, and so on. Plex keeps only one channel per number, so without this a whole group would collapse into a single entry.

**Omit `channel`** and matching channels are auto-numbered from 80000 instead.

**Filter a whole group** through `meta`, which is matched against the entire `#EXTINF` line, including `group-title`:

```javascript
{ "meta": "group-title=\"FRENCH\"", "channel": "1" }
```

**When both `name` and `meta` are given, both must match.** A filter that sets neither is ignored, since it would otherwise claim every channel.
