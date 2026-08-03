FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run lint && npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3004
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/scripts/backup.mjs ./scripts/backup.mjs
COPY --from=build /app/scripts/restore.mjs ./scripts/restore.mjs
COPY --from=build /app/scripts/prune.mjs ./scripts/prune.mjs
# 真实 BGM 曲库（Pixabay 免费商用），由 bgm-init 服务拷入上传卷
COPY --from=build /app/assets/bgm ./assets/bgm
RUN mkdir -p /var/lib/live-tu/data /var/lib/live-tu/uploads /var/lib/live-tu/backups \
    && chown -R node:node /app /var/lib/live-tu
USER node
EXPOSE 3004
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3004}/api/ready`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
