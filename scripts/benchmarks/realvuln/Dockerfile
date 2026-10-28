FROM python:3.12.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash coreutils findutils git ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
