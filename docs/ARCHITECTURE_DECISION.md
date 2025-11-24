# Architecture Decision: Convex vs Standalone WebSocket

**Date**: 2025-11-24
**Decision**: Use Convex real-time subscriptions instead of standalone WebSocket server

---

## Problem Statement

We need real-time bidirectional communication between the Next.js application and local Docker containers for command execution. The initial architecture proposed a standalone WebSocket server, but this approach is incompatible with our deployment platform (Vercel).

---

## Options Considered

### Option 1: Standalone WebSocket Server ❌

**Architecture:**
- WebSocket server on port 8080
- In-memory connection mapping (`userId → WebSocket`)
- Direct WebSocket connections from local client
- Promise-based command execution with event emitters

**Pros:**
- Direct communication (lowest latency: <20ms)
- Simple protocol design
- Explicit connection management
- Standard WebSocket patterns

**Cons:**
- **Requires persistent process** (incompatible with Vercel serverless)
- Needs separate hosting (Railway, Fly.io, or dedicated server)
- Additional infrastructure complexity
- State stored in memory (doesn't scale horizontally)
- Extra hosting costs

**Verdict**: Rejected due to Vercel incompatibility

---

### Option 2: Convex Real-Time Subscriptions ✅

**Architecture:**
- Convex tables for command queue and results
- Convex subscriptions (WebSocket-backed) for real-time updates
- Local client subscribes to Convex
- Server queues commands via Convex mutations

**Pros:**
- **Works perfectly on Vercel serverless**
- Uses existing Convex infrastructure
- Real-time via Convex's built-in WebSockets
- Horizontally scalable by default
- No additional hosting needed
- State persisted in database
- Automatic cleanup with scheduled functions

**Cons:**
- Slightly higher latency (~100ms vs ~20ms)
- More database operations
- Convex usage costs

**Verdict**: Selected as the optimal solution

---

## Decision Rationale

### Primary Factor: Vercel Compatibility

The application runs on Vercel, which uses serverless functions. Serverless functions are:
- **Stateless**: No persistent in-memory state
- **Ephemeral**: Spin up/down on demand
- **Event-driven**: Execute in response to HTTP requests

A standalone WebSocket server requires:
- **Persistent process**: Always running to maintain connections
- **Stateful**: Tracks active connections in memory
- **Long-running**: Never terminates

These requirements are fundamentally incompatible with Vercel's serverless architecture.

### Secondary Factor: Infrastructure Simplicity

**Standalone WebSocket Server:**
```
User's Machine → WebSocket → Separate Server → Vercel App
                              (Railway/Fly.io)
                              Extra hosting
                              Extra monitoring
                              Extra failure points
```

**Convex Real-Time:**
```
User's Machine → Convex (WebSocket) → Vercel App
                         (Existing infrastructure)
                         Already monitored
                         Already scaled
```

### Tertiary Factor: Cost

**Standalone WebSocket:**
- Vercel hosting: $20-200/month
- Separate server: $5-50/month
- **Total: $25-250/month**

**Convex Real-Time:**
- Vercel hosting: $20-200/month
- Convex usage: Included in existing plan
- **Total: $20-200/month** (no increase)

---

## Technical Comparison

### Latency

| Operation | Standalone WS | Convex RT | Difference |
|-----------|---------------|-----------|------------|
| Command delivery | 5-10ms | 50-100ms | +40-90ms |
| Result return | 5-10ms | 50-100ms | +40-90ms |
| **Total overhead** | **10-20ms** | **100-200ms** | **+90-180ms** |

**Impact**: For command execution times of 100ms-10s, the additional 200ms overhead (2-0.002%) is negligible.

### Scalability

| Aspect | Standalone WS | Convex RT |
|--------|---------------|-----------|
| Max connections | 10,000/server | Unlimited (Convex scales) |
| Horizontal scaling | Manual (load balancer) | Automatic (Convex) |
| State management | In-memory (lost on restart) | Persisted (database) |
| Failure recovery | Manual reconnect | Automatic (Convex) |

### Code Complexity

**Standalone WebSocket:**
```typescript
// lib/websocket/server.ts (400 lines)
// lib/websocket/connection-manager.ts (200 lines)
// lib/websocket/protocol.ts (100 lines)
// lib/websocket/init.ts (50 lines)
// Total: ~750 lines of WebSocket infrastructure
```

**Convex Real-Time:**
```typescript
// convex/localSandbox.ts (300 lines)
// lib/ai/tools/utils/convex-sandbox.ts (150 lines)
// Total: ~450 lines (40% less code)
```

---

## Implementation Differences

### Connection Management

**Standalone WebSocket:**
```typescript
// Server maintains map
clients.set(userId, websocket)

// Manual heartbeat checking
setInterval(() => {
  clients.forEach((ws, userId) => {
    if (Date.now() - ws.lastHeartbeat > 15000) {
      ws.terminate()
      clients.delete(userId)
    }
  })
}, 10000)
```

**Convex Real-Time:**
```typescript
// Convex table tracks connections
await ctx.db.insert('local_sandbox_connections', {
  user_id: userId,
  last_heartbeat: Date.now(),
  status: 'connected'
})

// Automatic cleanup via scheduled function
export const cleanupStaleConnections = internalMutation({
  schedule: "every minute",
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('local_sandbox_connections')
      .filter(q => q.lt(q.field('last_heartbeat'), Date.now() - 30000))
      .collect()

    for (const conn of stale) {
      await ctx.db.patch(conn._id, { status: 'disconnected' })
    }
  }
})
```

### Command Execution

**Standalone WebSocket:**
```typescript
// Send command via WebSocket
const commandId = crypto.randomUUID()
wsServer.sendCommand(userId, commandId, command)

// Wait for result via promise
return new Promise((resolve, reject) => {
  pendingCommands.set(commandId, { resolve, reject })
  // Result arrives via WebSocket message event
})
```

**Convex Real-Time:**
```typescript
// Enqueue command via mutation
const commandId = crypto.randomUUID()
await convex.mutation(api.localSandbox.enqueueCommand, {
  userId,
  commandId,
  command
})

// Subscribe to result
const unsubscribe = convex.onUpdate(
  api.localSandbox.getResult,
  { commandId },
  (result) => {
    if (result?.found) {
      unsubscribe()
      resolve(result)
    }
  }
)
```

### Local Client

**Standalone WebSocket:**
```typescript
// Connect to WebSocket server
const ws = new WebSocket('ws://localhost:8080')

ws.on('message', (data) => {
  const message = JSON.parse(data.toString())
  if (message.type === 'command') {
    executeCommand(message)
  }
})
```

**Convex Real-Time:**
```typescript
// Subscribe to Convex
const convex = new ConvexClient(convexUrl)

convex.onUpdate(
  api.localSandbox.getPendingCommands,
  { userId },
  async (data) => {
    for (const cmd of data.commands) {
      await executeCommand(cmd)
    }
  }
)
```

---

## Migration Path

Since there's no existing implementation, this is a greenfield decision. However, if we later need lower latency, we can:

1. **Hybrid approach**: Keep Convex for command queue, add WebSocket for result streaming
2. **Separate hosting**: Deploy WebSocket server to Fly.io when scale demands it
3. **Edge functions**: Use Cloudflare Workers with Durable Objects for stateful WebSockets

---

## Conclusion

**Decision: Use Convex Real-Time Subscriptions**

**Rationale:**
1. Works perfectly with Vercel serverless architecture
2. Uses existing infrastructure (no additional hosting)
3. Simpler implementation (40% less code)
4. Automatically scalable and fault-tolerant
5. Latency penalty (200ms) is negligible for typical command execution times
6. No additional costs

**Next Steps:**
1. Implement Convex schema and functions
2. Implement ConvexSandbox wrapper
3. Update HybridSandboxManager
4. Implement local client with Convex subscriptions
5. Add UI components
6. Test end-to-end
7. Deploy to Vercel

---

**Approved By**: [To be filled]
**Implementation Status**: Ready to begin
