# Where channels come from

A playlist URL, an Xtream account, or several of either combined into one lineup.

## Xtream accounts

If your provider gives you a username, a password and a server address, you can use those directly instead of a playlist URL:

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

That is all that is needed. The channel list, the logos, the guide ids and the group names all come from the provider's API, and the guide URL is the one that belongs to the account rather than something inferred.

It also checks the account before doing anything else and tells you what the provider said, so an expired or suspended line reports itself instead of turning up as an empty channel list:

```
Xtream account is Active, using 0/1 connections.
Xtream catalogue: 55406 live streams.
```

Filters, renaming, channel numbers and the limit all behave exactly as they do for a playlist, because the catalogue is turned into one internally. `m3u8.local` is still used, as the cache to fall back on if the provider is unreachable on a later start.

Set `m3u8.remote` instead if you have a playlist URL. If both are present, the Xtream account wins.

## Several providers at once

Got more than one subscription? `sources` takes a list. Mix accounts and playlist URLs however you like:

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

You can leave `type` out. An entry with a username and password is treated as an Xtream account, anything else as a playlist URL. `name` is just a label for the log and the dashboard; without it you get the hostname.

The playlists are stitched together before anything else runs, which matters more than it sounds: filters, renaming, numbering and the limit all see one combined lineup. So two providers cannot both grab channel 80000, and one filter can match channels from either of them.

If a provider is down, you keep the rest:

```
Loaded 412 channels from line.your-provider.tv.
Could not load Sports pack: Unexpected status 502 from other-provider.tv.
Carrying on without Sports pack. 1 of 2 sources loaded.
```

Only when every source fails does it fall back to the cached playlist.

Guides get merged as well. An entry can bring its own `epgUrl`, an Xtream account uses the guide that belongs to it, and everything arrives as one XMLTV feed. Set `epgUrl` at the top level and it overrides the lot.

Already using the single `xtream` block or `m3u8.remote`? Both still work, `sources` just takes priority. Nothing to change when you upgrade.
