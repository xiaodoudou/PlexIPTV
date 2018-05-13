FROM node:carbon

WORKDIR /opt/PlexIPTV

COPY package*.json ./
COPY yarn.lock ./

RUN yarn --production

COPY . .

EXPOSE 1245

CMD [ "npm", "start" ]
