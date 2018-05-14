FROM node:carbon

WORKDIR /opt/PlexIPTV

RUN mkdir -p ./config
VOLUME ["/opt/PlexIPTV/config"]

COPY package*.json ./
COPY yarn.lock ./

RUN yarn --production

COPY . .

RUN sed -i 's/iptv.m3u8/config\/iptv.m3u8/g' template.json

EXPOSE 1245

CMD [ "npm", "run", "start:docker" ]
