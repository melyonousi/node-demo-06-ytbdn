FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    YT_DLP_PATH=/usr/local/bin/yt-dlp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p /app/bin /app/tmp-downloads \
    && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "app.js"]
