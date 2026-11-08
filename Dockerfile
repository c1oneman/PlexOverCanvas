# Debian trixie ships ffmpeg 7.1, which has -readrate_initial_burst.
FROM node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
USER node
CMD ["node", "server/server.js"]
