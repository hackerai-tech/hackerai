# Centrifugo Deployment

Real-time pub/sub server for sandbox command relay.

## EC2 Setup (User Data)

Paste this into **Advanced Details → User Data** when launching an EC2 instance (Amazon Linux 2023, t3.micro, ports 22/443 open):

```bash
#!/bin/bash
set -e

# Install Docker
dnf install -y docker
systemctl enable docker
systemctl start docker

# Install Docker Compose plugin
mkdir -p /usr/local/lib/docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Create app directory
mkdir -p /opt/centrifugo
cd /opt/centrifugo

# Copy Centrifugo config (from docker/centrifugo/config.json in the repo)
cp config.json /opt/centrifugo/config.json

# Write docker-compose
cat > docker-compose.yml <<'COMPOSE'
services:
  centrifugo:
    image: centrifugo/centrifugo:v5
    restart: always
    ports:
      - "443:8000"
    volumes:
      - ./config.json:/centrifugo/config.json:ro
      - ./server.crt:/centrifugo/server.crt:ro
      - ./server.key:/centrifugo/server.key:ro
    environment:
      - CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=${CENTRIFUGO_TOKEN_SECRET}
      - CENTRIFUGO_API_KEY=${CENTRIFUGO_API_KEY}
      - CENTRIFUGO_TLS=true
      - CENTRIFUGO_TLS_CERT=/centrifugo/server.crt
      - CENTRIFUGO_TLS_KEY=/centrifugo/server.key
    command: centrifugo -c config.json
COMPOSE

# Write env file (replace with your secrets)
cat > .env <<'ENV'
CENTRIFUGO_TOKEN_SECRET=<your-token-secret>
CENTRIFUGO_API_KEY=<your-api-key>
ENV
chmod 600 .env

# Start services
docker compose up -d
```

## Channel Security

Channels use the format `sandbox:user#userId` where `#` is Centrifugo's user boundary. Combined with `allow_user_limited_channels: true`, only the JWT-authenticated user matching `userId` can subscribe to their channel.

## Environment Variables

**Vercel (.env.local):**

```
CENTRIFUGO_API_URL=https://rt.hackerai.co
CENTRIFUGO_API_KEY=<api-key>
CENTRIFUGO_TOKEN_SECRET=<token-secret>
CENTRIFUGO_WS_URL=wss://rt.hackerai.co/connection/websocket
```

**Convex Dashboard:**

```
CENTRIFUGO_TOKEN_SECRET=<token-secret>
CENTRIFUGO_WS_URL=wss://rt.hackerai.co/connection/websocket
```

## Useful Commands

```bash
# Check status
sudo docker compose -f /opt/centrifugo/docker-compose.yml ps

# View logs
sudo docker compose -f /opt/centrifugo/docker-compose.yml logs centrifugo --tail 20

# Restart
sudo docker compose -f /opt/centrifugo/docker-compose.yml restart
```
