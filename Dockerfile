# node:carbon was Node 8: end of life since 2019 and shipping a runtime with
# years of unpatched CVEs. Pinned to a current, supported Node on a minimal base.
FROM node:26-bookworm-slim

WORKDIR /opt/PlexIPTV

COPY package*.json ./

# --omit=dev keeps the build toolchain (pkg, eslint) out of the runtime image.
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN sed -i 's/iptv.m3u8/config\/iptv.m3u8/g' template.json \
 && mkdir -p ./config ./logs \
 && chown -R node:node /opt/PlexIPTV

VOLUME ["/opt/PlexIPTV/config"]

# Runs unprivileged: a compromise of the stream proxy should not land as root.
USER node

# Matches the default serverPort in template.json.
EXPOSE 1234

CMD [ "npm", "run", "start:docker" ]
