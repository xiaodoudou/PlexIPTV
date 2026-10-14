# node:carbon was Node 8: end of life since 2019 and shipping a runtime with
# years of unpatched CVEs. Pinned to a current, supported Node on a minimal base.
FROM node:26-bookworm-slim

# RTSP channels and fragmented-MP4 HLS are played through ffmpeg. Someone
# running the image has no easy way to add it themselves, so it ships here.
# The font is for the text on the slate shown when a channel fails to play.
# tini passes docker stop on to node, which ignores it when it runs as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/PlexIPTV

COPY package*.json ./

# --omit=dev keeps the build toolchain (pkg, eslint) out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The code stays owned by root, so the app cannot rewrite itself. Only the two
# folders it writes to belong to the node user.
RUN sed -i 's/iptv.m3u8/config\/iptv.m3u8/g' template.json \
 && mkdir -p ./config ./logs \
 && chown node:node ./config ./logs \
 && chmod 755 docker/entrypoint.sh

VOLUME ["/opt/PlexIPTV/config"]

# Starts as root only long enough for docker/entrypoint.sh to hand the config
# folder to PUID:PGID, 1000:1000 (the node user) by default. PlexIPTV itself
# never runs as root: a compromise of the stream proxy should not land as root.
ENTRYPOINT ["tini", "--", "/opt/PlexIPTV/docker/entrypoint.sh"]

# Matches the default serverPort in template.json.
EXPOSE 1234

# node rather than npm run start:docker: npm wants a writable home folder,
# which an arbitrary PUID does not have.
CMD ["node", "src/index.js", "-s", "./config/settings.json"]
