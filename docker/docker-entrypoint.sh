#!/bin/bash
# HackerAI Agent Sandbox — Docker Entrypoint
# Generates a CA cert, starts Caido web security proxy, authenticates, then keeps container alive.

set -e

CAIDO_PORT=48080
CAIDO_LOG=/tmp/caido.log
CAIDO_TOKEN_FILE=/tmp/caido-token
CAIDO_API=http://127.0.0.1:${CAIDO_PORT}
CERTS_DIR=/app/certs

# ============================================================================
# Step 1: Generate CA certificate for HTTPS interception
# ============================================================================
echo "[entrypoint] Generating CA certificate for HTTPS interception..."
mkdir -p "$CERTS_DIR"

if [ ! -f "$CERTS_DIR/ca.p12" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$CERTS_DIR/ca.key"
  openssl req -x509 -new -key "$CERTS_DIR/ca.key" \
    -out "$CERTS_DIR/ca.crt" \
    -days 3650 \
    -subj "/C=US/ST=CA/O=Security Testing/CN=HackerAI Root CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign"
  openssl pkcs12 -export \
    -out "$CERTS_DIR/ca.p12" \
    -inkey "$CERTS_DIR/ca.key" \
    -in "$CERTS_DIR/ca.crt" \
    -passout pass:"" \
    -name "HackerAI Root CA"
  echo "[entrypoint] CA certificate generated."
else
  echo "[entrypoint] CA certificate already exists, skipping generation."
fi

# Install CA cert to system trust store so curl, wget, etc. trust it
cp "$CERTS_DIR/ca.crt" /usr/local/share/ca-certificates/hackerai-caido-ca.crt
update-ca-certificates --fresh > /dev/null 2>&1 || true

# ============================================================================
# Step 2: Start Caido CLI as background daemon
# ============================================================================
echo "[entrypoint] Starting Caido web security proxy on port ${CAIDO_PORT}..."

caido-cli \
  --listen "0.0.0.0:${CAIDO_PORT}" \
  --allow-guests \
  --no-logging \
  --no-open \
  --import-ca-cert "$CERTS_DIR/ca.p12" \
  --import-ca-cert-pass "" \
  > "$CAIDO_LOG" 2>&1 &

CAIDO_PID=$!
echo "[entrypoint] Caido PID: ${CAIDO_PID}"

# ============================================================================
# Step 3: Poll until Caido GraphQL API is ready (up to 60 seconds)
# ============================================================================
echo "[entrypoint] Waiting for Caido to become ready..."
for i in $(seq 1 30); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${CAIDO_API}/graphql" \
    -H "Content-Type: application/json" \
    -d '{"query":"{ __typename }"}' 2>/dev/null || echo "000")

  if [ "$STATUS" = "200" ] || [ "$STATUS" = "400" ]; then
    echo "[entrypoint] Caido is ready (HTTP ${STATUS})"
    break
  fi

  if [ "$i" = "30" ]; then
    echo "[entrypoint] WARNING: Caido did not become ready in 60s. Check ${CAIDO_LOG}"
    tail -20 "$CAIDO_LOG" || true
    break
  fi

  sleep 2
done

# ============================================================================
# Step 4: Authenticate as guest and save token
# ============================================================================
echo "[entrypoint] Authenticating with Caido as guest..."
for attempt in 1 2 3 4 5; do
  AUTH_RESPONSE=$(curl -sL -X POST "${CAIDO_API}/graphql" \
    -H "Content-Type: application/json" \
    -d '{"query":"mutation LoginAsGuest { loginAsGuest { token { accessToken } } }"}' \
    2>/dev/null || echo "{}")

  TOKEN=$(echo "$AUTH_RESPONSE" | grep -Eo '"accessToken"\s*:\s*"[^"]*"' | cut -d'"' -f4 || echo "")

  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > "$CAIDO_TOKEN_FILE"
    echo "[entrypoint] Authenticated. Token saved to ${CAIDO_TOKEN_FILE}"
    break
  fi

  echo "[entrypoint] Auth attempt ${attempt} failed, retrying in $((attempt * 2))s..."
  sleep $((attempt * 2))
done

if [ -z "$TOKEN" ]; then
  echo "[entrypoint] WARNING: Could not retrieve Caido auth token after 5 attempts."
fi

# ============================================================================
# Step 5: Create and select a project
# ============================================================================
if [ -n "$TOKEN" ]; then
  echo "[entrypoint] Creating Caido project..."
  PROJECT_RESPONSE=$(curl -sL -X POST "${CAIDO_API}/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${TOKEN}" \
    -d '{"query":"mutation CreateProject { createProject(input: {name: \"sandbox\", temporary: true}) { project { id } } }"}' \
    2>/dev/null || echo "{}")

  PROJECT_ID=$(echo "$PROJECT_RESPONSE" | grep -Eo '"id"\s*:\s*"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

  if [ -n "$PROJECT_ID" ]; then
    curl -sL -X POST "${CAIDO_API}/graphql" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -d "{\"query\":\"mutation SelectProject { selectProject(id: \\\"${PROJECT_ID}\\\") { currentProject { project { id } } } }\"}" \
      > /dev/null 2>&1 || true
    echo "[entrypoint] Project '${PROJECT_ID}' created and selected."
  fi
fi

echo "[entrypoint] Caido ready. Proxy: http://0.0.0.0:${CAIDO_PORT} | API: ${CAIDO_API}/graphql"

# Keep container alive
exec tail -f /dev/null
