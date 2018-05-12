# PlexIPTV
This app simulate a DVR device for Plex by providing a layer to any IPTV provider (that provide a m3u8 playlist).

I created that app for several reaons:
- Other existing projects where too much complexe for my use (tvhProxy: https://github.com/jkaberg/tvhProxy)
- Not enougth flexible for my use (telly: https://github.com/tombowditch/telly)
- None of the existing projects where pulling a remote playlist

## What it does?
It does:
- pull remote m3u8 file to a local file
- if remote file isn't accessible it will fallback to the local file
- settings can help to filter play list and remap the channels
- proxy the IPTV stream so only the server will be seen as the "user"
- allow multiple concurent views into the same channel even if the provider block it

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

```javascript
{
  "m3u8": {
    "local": "iptv.m3u8", // Locale file
    "remote": "https://domain.fqd/blablabla.m3u8" // Remote URL of the playlist
  },
  "serverPort": 1234, // Server port
  "serverName": "PlexIPTV", // Name of the server
  "tunerCount": 1, // How many simultaneous feed your IPTV provider support
  "removeIfNotFoundOnFilter": true, // Will remove channel from playlist that aren't present on the filter list
  "filter": [ // Filter list
    {
      "name": ">>> US News", // Regex of the name to match on the playlist
      "channel": "1" // Channel that will use for the found matching channel name
    },
    {
      "name": ">>> World News",
      "channel": "2"
    }
  ]
}
```

## How to build yourself the app?
After have run `yarn`, if you are on windows you can use:
- for powershell/cmd: `npm run build:ps`
- for bash/sh: `npm run build:sh`
