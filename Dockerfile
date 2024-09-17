FROM docker.io/node:lts-alpine AS runner

WORKDIR /app

COPY package.json .

RUN npm install

COPY app.js .

COPY ./public ./public

CMD ["node", "."]