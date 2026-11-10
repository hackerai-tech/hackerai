# syntax=docker/dockerfile:1
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/local/package.json ./packages/local/package.json
COPY packages/desktop/package.json ./packages/desktop/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    corepack prepare pnpm@10.33.2 --activate && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --dir packages/local build && pnpm --filter @hackerai/local deploy --prod --legacy /out/local

FROM tools AS builder
ARG DOMAIN=tandi.tech
ENV NEXT_PUBLIC_SELF_HOSTED=true NEXT_PUBLIC_BASE_URL=https://${DOMAIN} NEXT_PUBLIC_CONVEX_URL=https://${DOMAIN}/convex
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm exec next build --webpack

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS web
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
CMD ["node", "server.js"]

FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS sandbox
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git python3 python3-venv python3-pip nmap dnsutils iputils-ping jq ripgrep unzip openssh-client procps && rm -rf /var/lib/apt/lists/*
COPY --from=tools --chown=node:node /out/local /opt/hackerai-local
USER node
WORKDIR /home/node
CMD ["node", "/opt/hackerai-local/dist/index.js", "--token-file", "/run/sandbox-token", "--name", "Sandbox VPS", "--convex-url", "http://backend:3210"]
