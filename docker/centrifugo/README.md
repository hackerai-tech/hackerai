# Centrifugo Deployment

Real-time pub/sub server for sandbox command relay.

## EC2 Setup

1. **Launch an EC2 instance** manually (Amazon Linux 2023, t3.micro)
2. **Security Group**: Open ports 22 (SSH) and 443 (HTTPS)
3. **SSH into the instance** and run the steps below

### Install Docker & Compose

```bash
sudo dnf install -y docker
sudo systemctl enable docker
sudo systemctl start docker

sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
```

### Create app directory and config

```bash
sudo mkdir -p /opt/centrifugo
cd /opt/centrifugo
```

Upload `config.json` from this repo (`docker/centrifugo/config.json`):

```bash
scp -i your-key.pem docker/centrifugo/config.json ec2-user@<instance-ip>:/tmp/
sudo mv /tmp/config.json /opt/centrifugo/config.json
```

### Create docker-compose.yml

```bash
sudo tee /opt/centrifugo/docker-compose.yml >/dev/null <<'COMPOSE'
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
```

### Create .env with secrets

Generate secrets with `openssl rand -hex 64` (two separate values).

```bash
sudo tee /opt/centrifugo/.env >/dev/null <<'ENV'
CENTRIFUGO_TOKEN_SECRET=<your-token-secret>
CENTRIFUGO_API_KEY=<your-api-key>
ENV
sudo chmod 600 /opt/centrifugo/.env
```

### TLS certificates

Place your TLS cert and key at `/opt/centrifugo/server.crt` and `/opt/centrifugo/server.key`.

### Start

```bash
cd /opt/centrifugo
sudo docker compose up -d
```

## Channel Security

Channels use the format `sandbox:user#userId` where `#` is Centrifugo's user boundary. Combined with `allow_user_limited_channels: true`, only the JWT-authenticated user matching `userId` can subscribe to their channel.

## Environment Variables

Set the same secrets across all three systems:

**Vercel:**

```
CENTRIFUGO_API_URL=https://<DOMAIN>
CENTRIFUGO_API_KEY=<api-key>
CENTRIFUGO_TOKEN_SECRET=<token-secret>
CENTRIFUGO_WS_URL=wss://<DOMAIN>/connection/websocket
```

**Convex Dashboard:**

```
CENTRIFUGO_TOKEN_SECRET=<token-secret>
CENTRIFUGO_WS_URL=wss://<DOMAIN>/connection/websocket
```

**Centrifugo Server (.env):**

```
CENTRIFUGO_TOKEN_SECRET=<token-secret>   # must match Vercel/Convex value
CENTRIFUGO_API_KEY=<api-key>             # must match Vercel value
```

## Useful Commands

```bash
# Check status
sudo docker compose -f /opt/centrifugo/docker-compose.yml ps

# View logs
sudo docker compose -f /opt/centrifugo/docker-compose.yml logs centrifugo --tail 20

# Restart
sudo docker compose -f /opt/centrifugo/docker-compose.yml restart

# Check number of active connections
curl -s -X POST https://<DOMAIN>/api/info \
  -H "Authorization: apikey <CENTRIFUGO_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```
