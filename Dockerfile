# 云托管默认在仓库根目录查找此文件，构建上下文也是仓库根目录。
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/video-ingest/package.json scripts/video-ingest/package-lock.json ./
RUN npm ci --omit=dev
COPY scripts/video-ingest ./
ENV PORT=80
EXPOSE 80
CMD ["node", "cloudRunServer.js"]
