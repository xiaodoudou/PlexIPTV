# Docker

You can pull the image by doing `docker pull xiaodoudoufr/plexiptv`, then you can run it by `docker run -p 12345:1234 --volume [your config path]:/opt/PlexIPTV/config -d xiaodoudoufr/plexiptv`

The images run as the unprivileged `node` user and install runtime dependencies only.
