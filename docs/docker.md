# Docker

PlexIPTV is on Docker Hub as [`xiaodoudoufr/plexiptv`](https://hub.docker.com/r/xiaodoudoufr/plexiptv), built for amd64 and arm64, so a Raspberry Pi on a 64-bit OS or an Apple Silicon Mac runs it natively. Every release publishes a new image.

## Tags

| Tag | What you get |
| --- | --- |
| `latest` | The newest release, on Debian (`node:26-bookworm-slim`) |
| `1.6.1`, `1.6` | A given release, or the newest patch of a minor version |
| `alpine`, `1.6.1-alpine`, `1.6-alpine` | The same on Alpine (`node:26-alpine`), a smaller download |

Avoid the `1.0.x` tags. They are from 2018 and miss nearly everything in the [changelog](https://github.com/xiaodoudou/PlexIPTV/blob/master/CHANGELOG.md).

## Running it

```bash
docker run -d --name plexiptv --restart unless-stopped -p 1234:1234 -v /path/to/config:/opt/PlexIPTV/config xiaodoudoufr/plexiptv
```

Swap `/path/to/config` for a folder of your own, such as `/srv/plexiptv` or `C:\plexiptv` on Windows. Or with Compose:

```yaml
services:
  plexiptv:
    image: xiaodoudoufr/plexiptv
    restart: unless-stopped
    ports:
      - "1234:1234"
    volumes:
      - ./config:/opt/PlexIPTV/config
```

PlexIPTV runs as user and group 1000, never as root. To run it as someone else, set `PUID` and `PGID`, for example `-e PUID=99 -e PGID=100` on Unraid. The container starts as root just long enough to hand the config folder to that user, so a folder you have not prepared, or one Docker created for you, works as it is.

## First start

The first start writes a `settings.json` into the config folder and prints a password for the [dashboard](https://github.com/xiaodoudou/PlexIPTV/blob/master/docs/dashboard.md). It is printed once and never written to the log file, so read it now:

```bash
docker logs plexiptv
```

Then put your provider in `settings.json` (see [where channels come from](https://github.com/xiaodoudou/PlexIPTV/blob/master/docs/sources.md)) and restart the container with `docker restart plexiptv`.

## Adding it to Plex

Plex usually cannot discover a container on Docker's default network, because discovery relies on multicast, which does not reach it. Add the tuner by hand as an HDHomeRun at `your-server:1234`. If you published a different host port, use that one.

On Linux you can run with `--network host` instead, which lets discovery work. The `-p` option is ignored in that mode, and the server listens on port 1234 of the host.

## ffmpeg

Both images include ffmpeg, so RTSP channels and HLS with fragmented MP4 segments play with nothing extra to install, and a channel that cannot play shows the reason on screen. See [streams and formats](https://github.com/xiaodoudou/PlexIPTV/blob/master/docs/streams.md) for when it is used. Pass `-e PLEXIPTV_FFMPEG=none` if you would rather it never runs.

## Logs

`logs.txt` is written inside the container, so it goes when the container is replaced. To keep it next to your settings, pass `-e PLEXIPTV_LOGDIR=/opt/PlexIPTV/config/logs`.

## Updating

```bash
docker pull xiaodoudoufr/plexiptv
```

```bash
docker rm -f plexiptv
```

Then run the same `docker run` command as before, or `docker compose pull` and `docker compose up -d` with Compose. Your settings and the cached playlist live in the config folder, so they carry over.

## Building it yourself

From a clone of the repository, `docker build -t plexiptv .` builds the Debian image, and adding `-f Dockerfile-alpine` builds the Alpine one. Your own `settings.json`, playlist and logs are left out of the image by `.dockerignore`.

Apart from the dashboard, the server has no authentication, so keep it on a trusted network and do not forward its port to the internet. More in [security](https://github.com/xiaodoudou/PlexIPTV/blob/master/docs/security.md).
