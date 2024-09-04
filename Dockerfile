FROM docker.io/node:lts-alpine AS runner

WORKDIR /app

COPY package.json .

RUN npm install

COPY app.js ./

CMD ["node", "app.js"]