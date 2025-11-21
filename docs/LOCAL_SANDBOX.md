# Local Sandbox Mode

Run AI commands on your local machine with full network access instead of cloud-based E2B sandboxes.

## Features

- **Network Access**: Scan your local network (192.168.x.x, 10.x.x.x)
- **Local Services**: Access services running on localhost
- **No Latency**: Commands execute directly on your machine
- **Cost Effective**: No E2B usage costs
- **Secure**: Isolated in Docker container

## Architecture

```
┌─────────────┐      HTTP/Polling     ┌──────────────┐
│   Browser   │ ◄─────────────────────► │   Backend    │
└─────────────┘                         │  (Next.js)   │
                                        └──────┬───────┘
                                               │
                                               │ HTTP API
                                               │
                                        ┌──────▼───────┐
                                        │ Local Client │
                                        │  (Node.js)   │
                                        └──────┬───────┘
                                               │
                                               │ Docker Exec
                                               │
                                        ┌──────▼───────┐
                                        │    Docker    │
                                        │  Container   │
                                        │ (--network   │
                                        │    host)     │
                                        └──────────────┘
```

## Quick Start

### Prerequisites

1. Docker installed and running
   ```bash
   docker --version
   ```

2. Node.js installed
   ```bash
   node --version
   ```

### Setup

1. **Get your auth token:**
   - Open Settings (gear icon in sidebar)
   - Go to Account tab
   - Find "Local Sandbox Token" section
   - Click "Copy" to copy your token

2. **Run the local client:**
   ```bash
   npm run local-sandbox -- --auth-token YOUR_TOKEN
   ```

3. **Wait for confirmation:**
   ```
   🚀 Starting local sandbox client...
   ✓ Docker is available
   ✓ Container created: abc123def456
   ✓ Common tools installed
   ✓ Connected to backend
   🎉 Local sandbox is ready!
   ```

4. **Use the app** - All commands now run locally!

## Advanced Usage

### Custom Backend URL

```bash
npm run local-sandbox -- \
  --auth-token YOUR_TOKEN \
  --backend-url https://your-domain.com
```

### Custom Docker Image

Use Kali Linux for pentesting:
```bash
npm run local-sandbox -- \
  --auth-token YOUR_TOKEN \
  --image kalilinux/kali-rolling
```

### Environment Variables

```bash
export AUTH_TOKEN=your_token
export BACKEND_URL=https://your-domain.com
npm run local-sandbox
```

## Security Considerations

### What's Isolated

- ✅ Filesystem (container has its own)
- ✅ Process namespace
- ✅ User permissions (runs as root in container)

### What's NOT Isolated

- ⚠️ **Network** (uses `--network host`)
- ⚠️ The AI can scan your local network
- ⚠️ Can access services on localhost

### Recommendations

1. **Review commands** before letting AI execute them
2. **Use firewall rules** to restrict container if needed
3. **Monitor activity** with `docker logs -f <container>`
4. **Stop anytime** with Ctrl+C
5. **Don't expose sensitive services** on localhost

## How It Works

### Command Flow

1. **Backend** queues a command for user
2. **Local client** polls `/api/local-sandbox` every 1s
3. **Client** fetches pending commands
4. **Client** executes in Docker:
   ```bash
   docker exec <container> bash -c "your command"
   ```
5. **Client** sends result back to backend
6. **Backend** returns result to AI

### Connection Management

- Client pings backend every 1s during poll
- Backend considers client disconnected after 30s without ping
- Backend automatically switches back to E2B if local disconnects

## Troubleshooting

### "Docker is not available"

```bash
# Start Docker
sudo systemctl start docker  # Linux
open -a Docker              # Mac
```

### "Failed to create container"

Check Docker permissions:
```bash
docker run hello-world
```

### "Failed to register with backend"

Verify auth token:
```bash
# Get new token from UI or run:
curl http://localhost:3000/api/local-sandbox \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Commands timeout

Increase timeout in client:
```typescript
// scripts/local-sandbox-client.ts
pollInterval: 1000,  // Change to 2000 or higher
```

### Container networking issues

Try without host network:
```bash
docker run -d -p 8080:8080 ubuntu:latest
```

## Development

### Running Locally

```bash
# Development mode
npm run dev

# In another terminal
npm run local-sandbox -- --auth-token test --backend-url http://localhost:3000
```

### Testing

```bash
# Test Docker execution
docker run --rm ubuntu:latest echo "Hello from Docker"

# Test API endpoint
curl http://localhost:3000/api/local-sandbox \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"connect","data":{"containerId":"test"}}'
```

### Architecture Components

1. **LocalDockerSandbox** (`lib/ai/tools/utils/local-docker-sandbox.ts`)
   - Event-based interface
   - Matches E2B sandbox API

2. **HybridSandboxManager** (`lib/ai/tools/utils/hybrid-sandbox-manager.ts`)
   - Auto-switches between E2B and local
   - Transparent to AI tools

3. **API Route** (`app/api/local-sandbox/route.ts`)
   - Handles client registration
   - Queues commands
   - Stores results

4. **Local Client** (`scripts/local-sandbox-client.ts`)
   - Manages Docker container
   - Polls for commands
   - Executes and reports results

5. **UI Toggle** (`components/local-sandbox-toggle.tsx`)
   - Shows connection status
   - Displays setup instructions

## Use Cases

### Internal Network Pentesting

```bash
# AI can now scan your network
nmap -sn 192.168.1.0/24
```

### Access Local Services

```bash
# Connect to local database
psql -h localhost -U postgres

# Access local API
curl http://localhost:8080/api
```

### Test Webhooks Locally

```bash
# AI can hit your local webhook endpoint
curl http://localhost:3000/webhook
```

### VPN Testing

```bash
# If you're on VPN, AI can access VPN resources
curl http://internal-server.company.local
```

## Comparison: Local vs E2B

| Feature | Local | E2B |
|---------|-------|-----|
| Network Access | ✅ Full (your LAN) | ❌ Only internet |
| Setup | 🔧 Requires Docker | ✅ Automatic |
| Cost | ✅ Free | 💰 Usage-based |
| Latency | ✅ None | ⚠️ Network delay |
| Security | ⚠️ Host network | ✅ Fully isolated |
| Persistence | 🔧 Manual | ✅ Auto-managed |
| Tools | 🔧 Must install | ✅ Pre-installed |

## Managing Your Auth Token

### Where to Find It
1. Click Settings icon in sidebar
2. Navigate to Account tab
3. Scroll to "Local Sandbox Token" section

### Token Features
- **Show/Hide**: Click eye icon to reveal/hide token
- **Copy**: One-click copy to clipboard
- **Regenerate**: Create new token (invalidates old one)

### Security Best Practices
- Keep token secret (like a password)
- Don't commit to version control
- Regenerate if compromised
- Each user has unique token
- Token only works for your account

### Token Format
```
hsb_<64-character-hex-string>
```

Example: `hsb_a1b2c3d4e5f6...` (64 chars after prefix)

## FAQ

**Q: Can I use both E2B and local in the same session?**
A: Yes! The system auto-switches based on local client connection.

**Q: What happens if local client crashes?**
A: System automatically falls back to E2B.

**Q: Can multiple users share one local client?**
A: No, each user needs their own local client.

**Q: Does this work on Windows?**
A: Yes, with Docker Desktop for Windows.

**Q: Can I use custom tools/images?**
A: Yes! Use `--image` flag with any Docker image.

**Q: How do I stop the local sandbox?**
A: Press Ctrl+C in the terminal running the client.
