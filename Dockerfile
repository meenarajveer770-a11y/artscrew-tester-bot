FROM node:20-alpine

# Install git for libsignal-node dependency
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "server.js"]
