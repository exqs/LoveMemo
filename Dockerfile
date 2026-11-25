# LoveMemo 服务端镜像：先打包前端，再放进只含 Node 运行时的精简镜像
# 构建：docker compose -f deploy/docker-compose.yml build

FROM node:22-bookworm-slim AS web
WORKDIR /src
RUN npm install -g pnpm@9.15.9
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN pnpm exec tsc -b && pnpm exec vite build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_OPTIONS="--disable-warning=ExperimentalWarning" \
    HOST=0.0.0.0 PORT=8787 \
    DATA_DIR=/data STATIC_DIR=/app/dist MODELS_FILE=/config/models.json
WORKDIR /app
# 服务端只用 Node 内置模块，不需要 npm install
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=web /src/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server/src/main.ts"]
