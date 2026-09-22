# Where channels come from

A playlist URL, an Xtream account, or several of either combined into one
lineup.

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

## Several providers at once

`sources` takes a list, so accounts and playlists can be combined into one
lineup. Each entry is either an Xtream account or a playlist URL:

```javascript
{
  "sources": [
    {
      "name": "Main line",
      "type": "xtream",
      "url": "http://line.your-provider.tv",
      "username": "your-username",
      "password": "your-password"
    },
    {
      "name": "Sports pack",
      "type": "m3u",
      "url": "http://other-provider.tv/get.php?username=...&password=...&type=m3u_plus"
    }
  ]
}
```

`type` can be left out: an entry with a username and a password is read as an
Xtream account, anything else as a playlist URL. `name` is only used in the log
and on the dashboard, and falls back to the host.

The playlists are merged before anything else happens, so filters, renaming,
channel numbers and the limit all run once over the combined lineup. Two
providers cannot both claim channel 80000, and a filter can match channels from
either of them.

One provider being down does not cost you the others. Each is loaded
independently, a failure is reported and skipped, and only if every one of them
fails does the app fall back to the cached copy:

```
Loaded 412 channels from line.your-provider.tv.
Could not load Sports pack: Unexpected status 502 from other-provider.tv.
Carrying on without Sports pack. 1 of 2 sources loaded.
```

Guides are merged too. Each entry can carry its own `epgUrl`, an Xtream account
uses the guide belonging to that account, and the programmes from all of them
are served as one XMLTV feed. A single `epgUrl` at the top level overrides the
lot.

`sources` takes precedence over the older single `xtream` block and
`m3u8.remote`, both of which still work, so nothing needs changing on an
upgrade.
