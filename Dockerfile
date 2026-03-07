FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    PATH=/opt/yt-dlp/bin:${PATH} \
    YT_DLP_PATH=/usr/local/bin/yt-dlp

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp \
    && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

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
