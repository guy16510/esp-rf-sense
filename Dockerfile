FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.base.json vitest.config.ts eslint.config.js .prettierrc.json ./
COPY tools ./tools
COPY apps ./apps
COPY docker ./docker

RUN npm ci && npm run build

ENV NODE_ENV=production
ENV RF_SENSE_DATA_DIR=/data
ENV RF_SENSE_HTTP_HOST=0.0.0.0
ENV RF_SENSE_HTTP_PORT=8080
ENV RF_SENSE_UDP_HOST=0.0.0.0
ENV RF_SENSE_UDP_PORT=5566

RUN mkdir -p /data/recordings /data/models
RUN chmod +x /app/docker/entrypoint.sh

VOLUME ["/data"]
EXPOSE 8080/tcp
EXPOSE 5566/udp

ENTRYPOINT ["/app/docker/entrypoint.sh"]
