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
  "doNotPullRemotePlaylist": false, // Will not pul online playlist
  "filter": [ // Filter list
    {
      "name": ">>> US News", // Regex of the name to match on the playlist
      "channel": "1" // Channel that will use for the found matching channel name
    },
    {
      "name": ">>> World News",
      "remame": "World News", // Will rename the channel to "World News"
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

## Docker
You can pull the image by doing `docker pull xiaodoudoufr/plexiptv`, then you can run it by `docker run -p 12345:1234 --volume [your config path]:/opt/PlexIPTV/config -d xiaodoudoufr/plexiptv`

## TODO:
- [x] Option to avoid pulling online playlist
- [x] Docker container
- [ ] Merge multiples online playlist
- [ ] Resolving nesting playlist

## How to build yourself the app?
After have run `yarn`, if you are on windows you can use: `npm run build` which will trigger all builds (windows, macos, linux, docker).
If you want build a specific target you can do for example `npm run build:win:x64`.


## Changelogs
```
current work in progress:
 - online playlist merging
 - investigating why buffer is failing on some specific IPTV vendor
 
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
