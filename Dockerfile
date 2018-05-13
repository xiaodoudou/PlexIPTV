FROM node:carbon

WORKDIR /opt/PlexIPTV

COPY package*.json ./
COPY yarn.lock ./

RUN yarn --production

COPY . .

RUN sed -i 's/localhost/0.0.0.0/g' settings.json

EXPOSE 1245

CMD [ "npm", "start" ]
