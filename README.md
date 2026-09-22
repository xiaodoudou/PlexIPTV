<div align="center">

# PlexIPTV

> An IPTV subscription as live TV in Plex, by pretending to be an HDHomeRun tuner

[![Build](https://img.shields.io/github/actions/workflow/status/xiaodoudou/PlexIPTV/ci.yml?branch=master&style=flat-square&label=build)](https://github.com/xiaodoudou/PlexIPTV/actions/workflows/ci.yml) [![GitHub Release](https://img.shields.io/github/v/release/xiaodoudou/PlexIPTV?style=flat-square&color=e94560)](https://github.com/xiaodoudou/PlexIPTV/releases/latest) [![License](https://img.shields.io/badge/License-Apache--2.0-blue?style=flat-square)](https://github.com/xiaodoudou/PlexIPTV/blob/master/LICENSE) [![Stars](https://img.shields.io/github/stars/xiaodoudou/PlexIPTV?style=flat-square&color=yellow)](https://github.com/xiaodoudou/PlexIPTV/stargazers) [![Node](https://img.shields.io/badge/Node-%3E%3D22-339933?style=flat-square)](#supported-systems) [![Docker](https://img.shields.io/badge/Docker-image-2496ed?style=flat-square)](docs/docker.md) [![Streams](https://img.shields.io/badge/Streams-MPEG--TS%20%7C%20HLS%20%7C%20RTSP-blueviolet?style=flat-square)](docs/streams.md)

This app simulates a DVR device for Plex, so an IPTV subscription shows up as live TV. Point it at an m3u playlist or at an Xtream account and Plex sees an HDHomeRun tuner.

</div>

---

## What it does

- takes an m3u playlist URL or an Xtream username and password, or several of both
- caches the playlist locally and falls back to it when the provider is down
- filters, renames and renumbers channels so Plex sees the lineup you want
- proxies the stream, so the provider only ever sees one viewer: the server
- lets several people watch the same channel on a line that allows one
- plays HLS and RTSP as well as raw MPEG-TS, repackaging where needed
- serves an XMLTV guide with your channel logos and programme listings
- shows what is playing, and why anything is not, on a password protected dashboard

## Getting started

Grab a binary from the [release page](https://github.com/xiaodoudou/PlexIPTV/releases) and run it. It drops a `settings.json` beside itself and prints a dashboard password to the console, which is worth noting down.

Put your provider in `settings.json`:

```javascript
{
  "sources": [
    {
      "name": "My provider",
      "type": "xtream",
      "url": "http://line.your-provider.tv",
      "username": "your-username",
      "password": "your-password"
    }
  ]
}
```

Or a playlist URL instead:

```javascript
{
  "sources": [
    { "name": "My provider", "type": "m3u", "url": "http://your-provider.tv/get.php?..." }
  ]
}
```

Restart it, then add the tuner in Plex as an HDHomeRun at `your-server:1234`. That is the whole setup.

Running from source instead:

```bash
npm install
npm start
```

## Documentation

| | |
|---|---|
| [Where channels come from](docs/sources.md) | Xtream accounts, playlist URLs, and combining several providers |
| [Settings](docs/settings.md) | Every key in `settings.json`, and how filters behave |
| [Streams and formats](docs/streams.md) | MPEG-TS, HLS and RTSP, and where ffmpeg is needed |
| [Channel logos and the guide](docs/guide.md) | How logos and programme listings reach Plex |
| [Dashboard](docs/dashboard.md) | The status page, and its password |
| [Docker](docs/docker.md) | Running the image |
| [Security](docs/security.md) | What it does to protect your subscription and your network |
| [Building and testing](docs/building.md) | Building the binaries yourself, running the tests |
| [Changelog](CHANGELOG.md) | What changed, and when |

## Supported systems

Mostly tested on Windows, though it should run anywhere Node 22 or newer does. If something breaks, open an issue and include the full logs:

- Linux
```bash
DEBUG=* ./PlexIPTV.linux-x64
```
- macOS
```bash
DEBUG=* ./PlexIPTV.macos.x64
```
- Windows
```powershell
set DEBUG=* & PlexIPTV.win.x64.exe & set debug =
```

## Why this exists

I wrote it because nothing else quite fit:

- [tvhProxy](https://github.com/jkaberg/tvhProxy) was more than I needed
- [telly](https://github.com/tombowditch/telly) was not flexible enough
- and none of them would pull a playlist from a URL

## TODO

- [x] Option to avoid pulling online playlist
- [x] Docker container
- [x] Resolving nesting playlist (HLS)
- [x] Xtream account support
- [x] RTSP channels
- [x] Channel logos and an XMLTV guide
- [x] Merge multiples online playlist
- [ ] Editing settings from the dashboard
