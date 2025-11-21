# Hybrid Sandbox Implementation Summary

## Overview

Implemented a hybrid sandbox system that allows users to switch between:
- **Cloud mode**: E2B sandboxes (default)
- **Local mode**: Docker containers on user's machine with full network access

## What Was Built

### 1. Local Docker Sandbox (`lib/ai/tools/utils/local-docker-sandbox.ts`)
- Event-based interface matching E2B API
- Handles command execution via messages
- Supports background processes
- Port exposure with `getHost(port)`

### 2. API Endpoint (`app/api/local-sandbox/route.ts`)
- `POST /api/local-sandbox` - Client communication
  - `type: "connect"` - Register local client
  - `type: "poll"` - Fetch pending commands
  - `type: "result"` - Submit command results
  - `type: "disconnect"` - Unregister client
- `GET /api/local-sandbox` - Check connection status
- In-memory storage for commands/results (use Redis in production)

### 3. Hybrid Sandbox Manager (`lib/ai/tools/utils/hybrid-sandbox-manager.ts`)
- Auto-switches between E2B and local based on connection status
- Wraps local sandbox to match E2B interface
- Transparent to AI tools - no code changes needed
- Polling-based result retrieval

### 4. Local Client Script (`scripts/local-sandbox-client.ts`)
- Standalone Node.js script users run on their machine
- Creates Docker container with `--network host`
- Polls backend every 1s for commands
- Executes commands via `docker exec`
- Sends results back to backend
- Graceful shutdown with Ctrl+C

### 5. UI Component (`components/local-sandbox-toggle.tsx`)
- Shows connection status badge
- Setup instructions in dialog
- Command copy button
- Security warnings
- Connection status polling (5s interval)

### 6. Database Schema (`convex/schema.ts`)
- Added `user_settings` table:
  - `use_local_sandbox`: boolean preference
  - `local_sandbox_token`: auth token for client
  - `updated_at`: timestamp

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     Browser/UI                       │
│                                                      │
│  ┌────────────────────────────────────────────────┐ │
│  │  LocalSandboxToggle Component                  │ │
│  │  - Connection status badge                     │ │
│  │  - Setup instructions                          │ │
│  └────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────┘
                        │ HTTP
                        ▼
┌─────────────────────────────────────────────────────┐
│                  Next.js Backend                     │
│                                                      │
│  ┌────────────────────────────────────────────────┐ │
│  │  /api/local-sandbox                            │ │
│  │  - Command queue (Map)                         │ │
│  │  - Result storage (Map)                        │ │
│  │  - Connection tracking                         │ │
│  └────────────────────────────────────────────────┘ │
│                        ▲                            │
│  ┌────────────────────┼──────────────────────────┐ │
│  │  HybridSandboxManager                         │ │
│  │  - Auto-switches mode                         │ │
│  │  - Wraps local sandbox                        │ │
│  └───────┬────────────┴──────────────────┬───────┘ │
│          │ E2B Mode        Local Mode    │          │
│          ▼                               ▼          │
│  ┌─────────────┐            ┌──────────────────┐   │
│  │ E2B Sandbox │            │ LocalDockerSandbox│   │
│  └─────────────┘            └──────────────────┘   │
└─────────────────────────────────────┬───────────────┘
                                      │ HTTP Polling
                                      ▼
                      ┌───────────────────────────────┐
                      │   Local Client (Node.js)      │
                      │   - Polls for commands        │
                      │   - Executes in Docker        │
                      │   - Sends results back        │
                      └───────────┬───────────────────┘
                                  │ Docker Exec
                                  ▼
                      ┌───────────────────────────────┐
                      │   Docker Container            │
                      │   - ubuntu:latest (or custom) │
                      │   - --network host            │
                      │   - Full local network access │
                      └───────────────────────────────┘
```

## Usage Flow

### User Perspective

1. **Enable Local Mode:**
   ```bash
   npm run local-sandbox -- --auth-token YOUR_TOKEN
   ```

2. **See confirmation:**
   ```
   🎉 Local sandbox is ready!
   ```

3. **Use normally** - All commands now run locally with network access

4. **Stop when done:** Press Ctrl+C

### System Perspective

1. **Local client** registers with backend via `/api/local-sandbox` POST
2. **Backend** marks user as having local connection
3. **AI** requests command execution
4. **HybridSandboxManager** detects local connection, uses local mode
5. **Backend** queues command for user
6. **Local client** polls, fetches command
7. **Local client** executes in Docker container
8. **Local client** sends result back
9. **Backend** stores result
10. **HybridSandboxManager** retrieves result from storage
11. **AI** receives result

## Files Created

1. `lib/ai/tools/utils/local-docker-sandbox.ts` - Local sandbox class
2. `lib/ai/tools/utils/hybrid-sandbox-manager.ts` - Mode switcher
3. `app/api/local-sandbox/route.ts` - API endpoint for client communication
4. `app/api/local-sandbox/token/route.ts` - API endpoint for token management
5. `scripts/local-sandbox-client.ts` - User-side client
6. `components/local-sandbox-toggle.tsx` - UI component with instructions
7. `docs/LOCAL_SANDBOX.md` - User documentation
8. `docs/HYBRID_SANDBOX_IMPLEMENTATION.md` - This file

## Files Modified

1. `convex/schema.ts` - Added `user_settings` table
2. `package.json` - Added `local-sandbox` script
3. `app/components/AccountTab.tsx` - Added token management UI

## Integration Points

### To Use Hybrid Sandbox

**Option 1: Automatic (Recommended)**
- System auto-detects local connection
- No code changes needed in existing tools

**Option 2: Explicit**
```typescript
import { HybridSandboxManager } from "@/lib/ai/tools/utils/hybrid-sandbox-manager";

// Replace DefaultSandboxManager with HybridSandboxManager
const sandboxManager = new HybridSandboxManager(
  userID,
  setSandboxCallback,
  initialSandbox
);

// Use normally - it handles the rest
const { sandbox } = await sandboxManager.getSandbox();
```

### To Add UI Toggle

```tsx
import { LocalSandboxToggle } from "@/components/local-sandbox-toggle";

// Add to header/sidebar
<LocalSandboxToggle />
```

## Security Considerations

### Isolation
- Commands run in Docker container (filesystem isolated)
- Host network exposed (security trade-off for functionality)
- User must explicitly opt-in by running local client

### Authentication
- Uses dedicated auth tokens (not Clerk session tokens)
- Tokens generated via `/api/local-sandbox/token` endpoint
- Format: `hsb_<64-hex-chars>`
- Token visible in Settings > Account tab
- Features:
  - Show/hide token
  - One-click copy
  - Regenerate (invalidates old token)
- Token verification for local client API calls
- User-specific command queues

### Recommendations
1. Add rate limiting to `/api/local-sandbox`
2. Use Redis instead of in-memory storage for production
3. Add command allowlist/blocklist
4. Implement user confirmation for dangerous commands
5. Add audit logging for all local executions

## Production Deployment

### Required Changes

1. **Replace in-memory storage with Redis:**
```typescript
// app/api/local-sandbox/route.ts
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// Replace Map with Redis operations
```

2. **Add rate limiting:**
```typescript
import { Ratelimit } from "@upstash/ratelimit";

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "10 s"),
});
```

3. **Environment variables:**
```env
# .env.local
UPSTASH_REDIS_URL=...
UPSTASH_REDIS_TOKEN=...
LOCAL_SANDBOX_ENABLED=true
```

4. **Add monitoring:**
- Track local sandbox usage
- Alert on suspicious commands
- Log all executions

## Testing

### Manual Testing

1. **Start backend:**
   ```bash
   npm run dev
   ```

2. **Start local client:**
   ```bash
   npm run local-sandbox -- --auth-token test
   ```

3. **Verify in UI:**
   - Badge shows "Local Connected"
   - Commands execute locally

4. **Test failover:**
   - Stop local client (Ctrl+C)
   - Badge shows "Cloud (E2B)"
   - Commands use E2B

### Automated Testing

```typescript
// __tests__/local-sandbox.test.ts
describe("Local Sandbox", () => {
  it("should register client", async () => {
    const response = await fetch("/api/local-sandbox", {
      method: "POST",
      body: JSON.stringify({ type: "connect", data: { containerId: "test" } }),
    });
    expect(response.ok).toBe(true);
  });

  it("should queue commands", async () => {
    queueCommand("user123", { id: "1", command: "echo hi", options: {} });
    // ...verify command in queue
  });
});
```

## Future Enhancements

1. **WebSocket support** - Replace polling with real-time communication
2. **Multi-container** - Support multiple containers per user
3. **Container templates** - Pre-configured images (Kali, Parrot, etc.)
4. **Resource limits** - CPU/memory constraints
5. **Network policies** - Fine-grained firewall rules
6. **Shared sandboxes** - Team access to same container
7. **Persistent storage** - Volume mounts for data persistence
8. **SSH access** - Direct shell access for debugging

## Troubleshooting

### Client won't connect
- Check Docker is running: `docker ps`
- Verify auth token is valid
- Check backend URL is correct
- Review firewall settings

### Commands timeout
- Increase poll interval
- Check Docker container health: `docker logs <container>`
- Verify network connectivity

### Backend memory issues
- Implement Redis for production
- Add TTL for stored results
- Clean up stale connections

## Cost Analysis

### E2B (Cloud)
- ~$0.001 per command
- ~$0.10 per hour runtime
- No local resources used

### Local Mode
- $0 API costs
- Uses local compute/network
- Requires Docker

### Recommendation
- Use E2B for general tasks
- Use local for network-specific tasks
- Switch based on task requirements
