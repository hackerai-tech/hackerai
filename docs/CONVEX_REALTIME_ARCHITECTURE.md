# Convex Real-Time Local Sandbox Architecture

**Status**: Implementation Plan
**Date**: 2025-11-24
**Goal**: Enable AI to execute commands on user's local machine via Convex real-time subscriptions

---

## Executive Summary

Design and implement a Convex-based local sandbox system that allows users to run AI commands on their local machine through Docker containers, with seamless fallback to E2B cloud sandboxes.

**Key Features:**
- Real-time bidirectional communication via Convex subscriptions (WebSocket-backed)
- One-command setup for users: `npx hackerai-local --token TOKEN`
- **Chat-level sandbox selector**: Choose E2B, Local, or specific local connection per chat
- **Multiple local connections**: Run multiple local sandboxes (different machines/containers)
- **Dangerous mode**: Option to run directly on host OS (no Docker isolation)
- **OS detection**: AI automatically informed about host OS in dangerous mode
- Sub-100ms command delivery latency
- Docker container isolation with host networking for local network access
- **Works on Vercel serverless** (no persistent processes needed)

**Why Convex?**
- Convex is automatically real-time using WebSockets internally
- No standalone WebSocket server needed
- Works perfectly with Vercel's serverless architecture
- Existing infrastructure, no extra hosting costs

---

## Table of Contents

1. [System Architecture](#system-architecture)
2. [Technical Design](#technical-design)
3. [Implementation Plan](#implementation-plan)
4. [User Experience](#user-experience)
5. [Security Model](#security-model)
6. [Performance Specifications](#performance-specifications)
7. [Deployment Guide](#deployment-guide)

---

## System Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────┐
│                     Browser/UI                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │  Local Sandbox Settings Tab                        │ │
│  │  - Real-time connection status (useQuery)          │ │
│  │  - Token management (show/copy/regenerate)         │ │
│  │  - One-click setup instructions                    │ │
│  └────────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────────┘
                        │ Convex Query (WebSocket)
                        │ Auto-updates on DB changes
                        │
┌───────────────────────▼─────────────────────────────────┐
│              Next.js Application (Vercel)                │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │  HybridSandboxManager                              │ │
│  │                                                    │ │
│  │  getSandbox():                                     │ │
│  │    if (hasActiveConnection(userId))                │ │
│  │      return ConvexSandbox                          │ │
│  │    else                                            │ │
│  │      return E2BSandbox                             │ │
│  └────────────┬───────────────────┬───────────────────┘ │
│               │                   │                      │
│      ConvexSandbox                │ E2BSandbox           │
│      (Local Docker)               │ (Cloud Fallback)     │
│               │                   │                      │
│  ┌────────────▼───────────────────────────────────────┐ │
│  │  Convex Mutations (Command Queueing)              │ │
│  │  - enqueueCommand({ userId, cmd, env, cwd })      │ │
│  │  - Result promise resolved by subscription        │ │
│  └────────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────────┘
                        │
                        │ Convex Real-Time Subscriptions
                        │ (WebSocket Connection)
                        │
┌───────────────────────▼─────────────────────────────────┐
│                   Convex Backend                         │
│                                                          │
│  Tables:                                                 │
│  ┌────────────────────────────────────────────────────┐ │
│  │ local_sandbox_connections                          │ │
│  │  - user_id (indexed)                               │ │
│  │  - container_id                                    │ │
│  │  - client_version                                  │ │
│  │  - last_heartbeat                                  │ │
│  │  - status: "connected" | "disconnected"            │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ local_sandbox_commands                             │ │
│  │  - user_id (indexed)                               │ │
│  │  - command_id (UUID)                               │ │
│  │  - command (shell command string)                  │ │
│  │  - env (optional env vars)                         │ │
│  │  - cwd (optional working directory)                │ │
│  │  - timeout (optional timeout in ms)                │ │
│  │  - status: "pending" | "executing" | "completed"   │ │
│  │  - created_at                                      │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ local_sandbox_results                              │ │
│  │  - command_id (indexed)                            │ │
│  │  - user_id (indexed)                               │ │
│  │  - stdout (string)                                 │ │
│  │  - stderr (string)                                 │ │
│  │  - exit_code (number)                              │ │
│  │  - duration (ms)                                   │ │
│  │  - completed_at                                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐ │
│  │ user_settings (existing table)                     │ │
│  │  - user_id (indexed)                               │ │
│  │  - local_sandbox_token: "hsb_..."                  │ │
│  │  - token_created_at                                │ │
│  └────────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────────┘
                        │
                        │ Convex Subscription (WebSocket)
                        │ Watches: local_sandbox_commands
                        │
                 ┌──────▼──────┐
                 │Local Client │
                 │  (Node.js)  │
                 │             │
                 │ Features:   │
                 │ - Auth      │
                 │ - Subscribe │ ← Convex subscription
                 │ - Heartbeat │
                 │ - Execute   │
                 └──────┬──────┘
                        │ docker exec
                 ┌──────▼──────┐
                 │   Docker    │
                 │  Container  │
                 │             │
                 │ --network   │
                 │    host     │
                 └─────────────┘
```

### Advanced Features

#### 1. Multiple Local Connections

Users can run multiple local sandboxes simultaneously:

```bash
# On work laptop
npx hackerai-local --token TOKEN --name "Work Laptop"

# On Kali Linux machine
npx hackerai-local --token TOKEN --name "Kali Linux" --image kalilinux/kali-rolling

# On Mac Mini (dangerous mode)
npx hackerai-local --token TOKEN --name "Mac Mini" --dangerous
```

**Benefits:**
- Different machines for different tasks
- Multiple OS environments (Linux, macOS, Windows)
- Specialized containers (Kali, Ubuntu, custom images)
- Parallel execution across machines

**UI Display:**
```
🟢 Work Laptop (Docker: ubuntu:latest)
🟢 Kali Linux (Docker: kali-rolling)
🟢 Mac Mini (Dangerous: macOS 14.1)
```

#### 2. Chat-Level Sandbox Selector

Similar to Cursor's model selector, users choose sandbox per chat:

```
New Chat UI:
┌─────────────────────────────────────┐
│ Select Sandbox:                     │
│ ○ E2B Cloud (Auto-pause) [$10/day] │
│ ● Work Laptop (Local)               │
│ ○ Kali Linux (Local)                │
│ ○ Mac Mini (Dangerous)              │
└─────────────────────────────────────┘
```

**Default behavior:**
- If no local connections: Auto-select E2B
- If one local connection: Auto-select local
- If multiple local connections: Show selector
- User preference saved per chat

#### 3. Dangerous Mode (No Docker)

Run commands directly on host OS without Docker isolation:

```bash
npx hackerai-local --token TOKEN --dangerous
```

**When to use:**
- Need access to specific hardware (GPU, USB devices)
- Testing OS-specific features
- No Docker installed
- Maximum performance (no containerization overhead)

**Safety measures:**
- Explicit `--dangerous` flag required
- Big warning in UI: ⚠️ DANGEROUS MODE - Direct OS Access
- AI receives OS information (platform, arch, version)
- User can review commands before execution (optional)

**OS Detection:**
```typescript
// Client sends OS info to Convex
{
  platform: "darwin",      // or "linux", "win32"
  arch: "arm64",           // or "x64"
  release: "14.1.0",       // macOS 14.1, Ubuntu 22.04, etc.
  hostname: "MacBook-Pro"
}
```

**AI receives context:**
```
System: You are executing commands on macOS 14.1 (arm64) in DANGEROUS MODE.
Commands run directly on the host OS without isolation. Be careful with:
- File system operations (no sandbox protection)
- Network operations (direct access to host network)
- Process management (can affect host system)
```

#### 4. Connection Management

**Naming connections:**
```bash
# User-friendly names for easy identification
npx hackerai-local --token TOKEN --name "Gaming PC"
npx hackerai-local --token TOKEN --name "Raspberry Pi"
npx hackerai-local --token TOKEN --name "AWS EC2 Instance"
```

**Connection metadata:**
- Name: User-provided identifier
- Mode: Docker or Dangerous
- OS Info: Platform details (dangerous mode only)
- Image: Docker image (docker mode only)
- Status: Connected/Disconnected
- Last seen: Heartbeat timestamp

### Component Responsibilities

#### HybridSandboxManager
- Check chat-level sandbox preference
- Query available local connections
- Create ConvexSandbox for selected local connection
- Fallback to E2B Sandbox when local unavailable
- Transparent to AI tools (same interface)

#### ConvexSandbox
- Implement E2B-compatible interface
- Queue commands via Convex mutation `enqueueCommand`
- Subscribe to command results via Convex subscription
- Return results as promises
- Handle timeouts and errors

#### Local Client
- Create and manage Docker container
- Authenticate with token via Convex mutation
- Subscribe to command queue via Convex subscription (real-time)
- Execute commands in Docker via `docker exec`
- Store results via Convex mutation
- Send heartbeats every 10s via Convex mutation

#### Convex Backend
- Store connection state (user → container mapping)
- Queue pending commands
- Store command results
- Manage authentication tokens
- Provide real-time subscriptions (WebSocket-backed)

---

## Technical Design

### Convex Schema

```typescript
// convex/schema.ts

export default defineSchema({
  // ... existing tables ...

  user_settings: defineTable({
    user_id: v.string(),
    local_sandbox_token: v.optional(v.string()),
    token_created_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index('by_user_id', ['user_id'])
    .index('by_token', ['local_sandbox_token']),

  local_sandbox_connections: defineTable({
    user_id: v.string(),
    connection_id: v.string(),        // Unique ID for this connection
    connection_name: v.string(),      // User-friendly name ("Work Laptop", "Kali Linux", etc.)
    container_id: v.optional(v.string()), // Optional: null if dangerous mode
    client_version: v.string(),
    mode: v.union(v.literal('docker'), v.literal('dangerous')),
    os_info: v.optional(v.object({    // For dangerous mode: OS details for AI
      platform: v.string(),           // "linux", "darwin", "win32"
      arch: v.string(),               // "x64", "arm64"
      release: v.string(),            // OS version
      hostname: v.string(),
    })),
    last_heartbeat: v.number(),
    status: v.union(v.literal('connected'), v.literal('disconnected')),
    created_at: v.number(),
  })
    .index('by_user_id', ['user_id'])
    .index('by_connection_id', ['connection_id'])
    .index('by_user_and_status', ['user_id', 'status'])
    .index('by_status', ['status', 'last_heartbeat']),

  local_sandbox_commands: defineTable({
    user_id: v.string(),
    connection_id: v.string(),        // Target specific connection
    command_id: v.string(),
    command: v.string(),
    env: v.optional(v.any()),
    cwd: v.optional(v.string()),
    timeout: v.optional(v.number()),
    status: v.union(
      v.literal('pending'),
      v.literal('executing'),
      v.literal('completed')
    ),
    created_at: v.number(),
  })
    .index('by_user_id', ['user_id'])
    .index('by_command_id', ['command_id'])
    .index('by_connection_id', ['connection_id', 'status', 'created_at'])
    .index('by_user_and_status', ['user_id', 'status', 'created_at']),

  local_sandbox_results: defineTable({
    command_id: v.string(),
    user_id: v.string(),
    stdout: v.string(),
    stderr: v.string(),
    exit_code: v.number(),
    duration: v.number(),
    completed_at: v.number(),
  })
    .index('by_command_id', ['command_id'])
    .index('by_user_id', ['user_id']),
})
```

### Convex Functions

#### File: `convex/localSandbox.ts`

```typescript
import { v } from 'convex/values'
import { mutation, query, internalMutation } from './_generated/server'

// ============================================================================
// TOKEN MANAGEMENT
// ============================================================================

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let token = 'hsb_'
  for (let i = 0; i < 64; i++) {
    token += chars[Math.floor(Math.random() * chars.length)]
  }
  return token
}

export const getToken = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query('user_settings')
      .withIndex('by_user_id', q => q.eq('user_id', userId))
      .first()

    if (existing?.local_sandbox_token) {
      return { token: existing.local_sandbox_token }
    }

    const token = generateToken()

    if (existing) {
      await ctx.db.patch(existing._id, {
        local_sandbox_token: token,
        token_created_at: Date.now(),
        updated_at: Date.now()
      })
    } else {
      await ctx.db.insert('user_settings', {
        user_id: userId,
        local_sandbox_token: token,
        token_created_at: Date.now(),
        updated_at: Date.now()
      })
    }

    return { token }
  }
})

export const regenerateToken = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const token = generateToken()

    const existing = await ctx.db
      .query('user_settings')
      .withIndex('by_user_id', q => q.eq('user_id', userId))
      .first()

    if (existing) {
      await ctx.db.patch(existing._id, {
        local_sandbox_token: token,
        token_created_at: Date.now(),
        updated_at: Date.now()
      })
    } else {
      await ctx.db.insert('user_settings', {
        user_id: userId,
        local_sandbox_token: token,
        token_created_at: Date.now(),
        updated_at: Date.now()
      })
    }

    // Disconnect any existing connection
    const connection = await ctx.db
      .query('local_sandbox_connections')
      .withIndex('by_user_id', q => q.eq('user_id', userId))
      .first()

    if (connection) {
      await ctx.db.patch(connection._id, {
        status: 'disconnected'
      })
    }

    return { token }
  }
})

export const verifyToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const settings = await ctx.db
      .query('user_settings')
      .withIndex('by_token', q => q.eq('local_sandbox_token', token))
      .first()

    return settings
      ? { valid: true, userId: settings.user_id }
      : { valid: false, userId: null }
  }
})

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

export const connect = mutation({
  args: {
    token: v.string(),
    connectionName: v.string(),
    containerId: v.optional(v.string()),    // Optional: null for dangerous mode
    clientVersion: v.string(),
    mode: v.union(v.literal('docker'), v.literal('dangerous')),
    osInfo: v.optional(v.object({
      platform: v.string(),
      arch: v.string(),
      release: v.string(),
      hostname: v.string(),
    }))
  },
  handler: async (ctx, { token, connectionName, containerId, clientVersion, mode, osInfo }) => {
    // Verify token
    const settings = await ctx.db
      .query('user_settings')
      .withIndex('by_token', q => q.eq('local_sandbox_token', token))
      .first()

    if (!settings) {
      throw new Error('Invalid token')
    }

    const userId = settings.user_id
    const connectionId = crypto.randomUUID()

    // Create new connection (multiple connections allowed)
    await ctx.db.insert('local_sandbox_connections', {
      user_id: userId,
      connection_id: connectionId,
      connection_name: connectionName,
      container_id: containerId,
      client_version: clientVersion,
      mode: mode,
      os_info: osInfo,
      last_heartbeat: Date.now(),
      status: 'connected',
      created_at: Date.now()
    })

    return { success: true, userId, connectionId }
  }
})

export const heartbeat = mutation({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query('local_sandbox_connections')
      .withIndex('by_connection_id', q => q.eq('connection_id', connectionId))
      .first()

    if (!connection) {
      return { success: false, error: 'No connection found' }
    }

    await ctx.db.patch(connection._id, {
      last_heartbeat: Date.now()
    })

    return { success: true }
  }
})

export const listConnections = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const connections = await ctx.db
      .query('local_sandbox_connections')
      .withIndex('by_user_and_status', q =>
        q.eq('user_id', userId).eq('status', 'connected')
      )
      .collect()

    // Check heartbeat timeout (30 seconds)
    const now = Date.now()
    const timeout = 30000

    return connections
      .filter(conn => now - conn.last_heartbeat < timeout)
      .map(conn => ({
        connectionId: conn.connection_id,
        name: conn.connection_name,
        mode: conn.mode,
        osInfo: conn.os_info,
        containerId: conn.container_id,
        lastSeen: conn.last_heartbeat
      }))
  }
})

export const disconnect = mutation({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query('local_sandbox_connections')
      .withIndex('by_connection_id', q => q.eq('connection_id', connectionId))
      .first()

    if (connection) {
      await ctx.db.patch(connection._id, {
        status: 'disconnected'
      })
    }

    return { success: true }
  }
})

export const isConnected = query({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db
      .query('local_sandbox_connections')
      .withIndex('by_connection_id', q => q.eq('connection_id', connectionId))
      .first()

    if (!connection || connection.status !== 'connected') {
      return { connected: false }
    }

    // Check heartbeat timeout (30 seconds)
    const now = Date.now()
    const timeout = 30000

    if (now - connection.last_heartbeat > timeout) {
      return { connected: false }
    }

    return {
      connected: true,
      containerId: connection.container_id,
      mode: connection.mode,
      osInfo: connection.os_info
    }
  }
})

// ============================================================================
// COMMAND EXECUTION
// ============================================================================

export const enqueueCommand = mutation({
  args: {
    userId: v.string(),
    connectionId: v.string(),  // Target specific connection
    commandId: v.string(),
    command: v.string(),
    env: v.optional(v.any()),
    cwd: v.optional(v.string()),
    timeout: v.optional(v.number())
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('local_sandbox_commands', {
      user_id: args.userId,
      connection_id: args.connectionId,
      command_id: args.commandId,
      command: args.command,
      env: args.env,
      cwd: args.cwd,
      timeout: args.timeout,
      status: 'pending',
      created_at: Date.now()
    })

    return { success: true }
  }
})

export const getPendingCommands = query({
  args: { connectionId: v.string() },
  handler: async (ctx, { connectionId }) => {
    const commands = await ctx.db
      .query('local_sandbox_commands')
      .withIndex('by_connection_id', q =>
        q.eq('connection_id', connectionId).eq('status', 'pending')
      )
      .order('asc')
      .take(10)

    return { commands }
  }
})

export const markCommandExecuting = mutation({
  args: { commandId: v.string() },
  handler: async (ctx, { commandId }) => {
    const command = await ctx.db
      .query('local_sandbox_commands')
      .withIndex('by_command_id', q => q.eq('command_id', commandId))
      .first()

    if (!command) {
      throw new Error('Command not found')
    }

    await ctx.db.patch(command._id, {
      status: 'executing'
    })

    return { success: true }
  }
})

export const submitResult = mutation({
  args: {
    commandId: v.string(),
    userId: v.string(),
    stdout: v.string(),
    stderr: v.string(),
    exitCode: v.number(),
    duration: v.number()
  },
  handler: async (ctx, args) => {
    // Store result
    await ctx.db.insert('local_sandbox_results', {
      command_id: args.commandId,
      user_id: args.userId,
      stdout: args.stdout,
      stderr: args.stderr,
      exit_code: args.exitCode,
      duration: args.duration,
      completed_at: Date.now()
    })

    // Mark command as completed
    const command = await ctx.db
      .query('local_sandbox_commands')
      .withIndex('by_command_id', q => q.eq('command_id', args.commandId))
      .first()

    if (command) {
      await ctx.db.patch(command._id, {
        status: 'completed'
      })
    }

    return { success: true }
  }
})

export const getResult = query({
  args: { commandId: v.string() },
  handler: async (ctx, { commandId }) => {
    const result = await ctx.db
      .query('local_sandbox_results')
      .withIndex('by_command_id', q => q.eq('command_id', commandId))
      .first()

    return result
      ? {
          found: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exit_code,
          duration: result.duration
        }
      : { found: false }
  }
})

// ============================================================================
// CLEANUP (scheduled function to run every minute)
// ============================================================================

export const cleanupOldCommands = internalMutation({
  handler: async (ctx) => {
    const now = Date.now()
    const maxAge = 60 * 60 * 1000 // 1 hour

    // Delete old completed commands
    const oldCommands = await ctx.db
      .query('local_sandbox_commands')
      .withIndex('by_user_and_status', q => q.eq('status', 'completed'))
      .filter(q => q.lt(q.field('created_at'), now - maxAge))
      .collect()

    for (const cmd of oldCommands) {
      await ctx.db.delete(cmd._id)
    }

    // Delete old results
    const oldResults = await ctx.db
      .query('local_sandbox_results')
      .filter(q => q.lt(q.field('completed_at'), now - maxAge))
      .collect()

    for (const result of oldResults) {
      await ctx.db.delete(result._id)
    }

    return { deleted: oldCommands.length + oldResults.length }
  }
})
```

### ConvexSandbox Implementation

#### File: `lib/ai/tools/utils/convex-sandbox.ts`

```typescript
import { EventEmitter } from 'events'
import { ConvexClient } from 'convex/browser'
import { api } from '@/convex/_generated/api'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Convex-based sandbox that implements E2B-compatible interface
 * Uses Convex real-time subscriptions for command execution
 */
export class ConvexSandbox extends EventEmitter {
  private convex: ConvexClient

  constructor(
    private userId: string,
    convexUrl: string
  ) {
    super()
    this.convex = new ConvexClient(convexUrl)
  }

  // E2B-compatible interface: commands.run()
  commands = {
    run: async (
      command: string,
      opts?: {
        envVars?: Record<string, string>
        cwd?: string
        timeoutMs?: number
        background?: boolean
        onStdout?: (data: string) => void
        onStderr?: (data: string) => void
      }
    ) => {
      if (opts?.background) {
        throw new Error('Background commands not supported in local sandbox')
      }

      const commandId = crypto.randomUUID()
      const timeout = opts?.timeoutMs ?? 30000

      // Enqueue command in Convex
      await this.convex.mutation(api.localSandbox.enqueueCommand, {
        userId: this.userId,
        commandId,
        command,
        env: opts?.envVars,
        cwd: opts?.cwd ?? '/home/user',
        timeout
      })

      // Wait for result with timeout
      const result = await this.waitForResult(commandId, timeout)

      // Stream output if handlers provided
      if (opts?.onStdout && result.stdout) {
        opts.onStdout(result.stdout)
      }
      if (opts?.onStderr && result.stderr) {
        opts.onStderr(result.stderr)
      }

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? 0
      }
    }
  }

  private async waitForResult(
    commandId: string,
    timeout: number
  ): Promise<CommandResult> {
    const startTime = Date.now()

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Command timeout after ${timeout}ms`))
      }, timeout + 5000) // Add 5s buffer for network

      // Subscribe to result
      const unsubscribe = this.convex.onUpdate(
        api.localSandbox.getResult,
        { commandId },
        (result) => {
          if (result?.found) {
            clearTimeout(timeoutHandle)
            unsubscribe()
            resolve({
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode
            })
          }
        }
      )

      // Also check periodically in case subscription misses
      const checkInterval = setInterval(async () => {
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval)
          return
        }

        const result = await this.convex.query(api.localSandbox.getResult, {
          commandId
        })

        if (result?.found) {
          clearTimeout(timeoutHandle)
          clearInterval(checkInterval)
          unsubscribe()
          resolve({
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode
          })
        }
      }, 500)
    })
  }

  // E2B-compatible interface: files operations
  files = {
    write: async (path: string, content: string | Buffer) => {
      const contentStr =
        typeof content === 'string' ? content : content.toString('base64')

      const command =
        typeof content === 'string'
          ? `cat > ${path} <<'EOF'\n${contentStr}\nEOF`
          : `echo "${contentStr}" | base64 -d > ${path}`

      await this.commands.run(command)
    },

    read: async (path: string): Promise<string> => {
      const result = await this.commands.run(`cat ${path}`)
      if (result.exitCode !== 0) {
        throw new Error(`Failed to read file: ${result.stderr}`)
      }
      return result.stdout
    },

    remove: async (path: string) => {
      await this.commands.run(`rm -rf ${path}`)
    },

    list: async (path: string = '/') => {
      const result = await this.commands.run(
        `find ${path} -maxdepth 1 -type f`
      )
      if (result.exitCode !== 0) return []

      return result.stdout
        .split('\n')
        .filter(Boolean)
        .map(name => ({ name }))
    }
  }

  // E2B-compatible interface: getHost()
  getHost(port: number): string {
    return `localhost:${port}`
  }

  // E2B-compatible interface: close()
  async close(): Promise<void> {
    this.emit('close')
  }
}
```

### HybridSandboxManager Implementation

#### File: `lib/ai/tools/utils/hybrid-sandbox-manager.ts`

```typescript
import { Sandbox } from '@e2b/code-interpreter'
import type { SandboxManager } from '@/types'
import { ConvexSandbox } from './convex-sandbox'
import { ConvexClient } from 'convex/browser'
import { api } from '@/convex/_generated/api'

/**
 * Hybrid sandbox manager that automatically switches between
 * local Convex sandbox and E2B cloud sandbox based on connection status
 */
export class HybridSandboxManager implements SandboxManager {
  private sandbox: Sandbox | ConvexSandbox | null = null
  private isLocal = false
  private convex: ConvexClient

  constructor(
    private userID: string,
    private setSandboxCallback: (sandbox: any) => void,
    initialSandbox?: Sandbox | null
  ) {
    this.sandbox = initialSandbox || null
    this.convex = new ConvexClient(process.env.NEXT_PUBLIC_CONVEX_URL!)
  }

  async getSandbox(): Promise<{ sandbox: Sandbox | ConvexSandbox }> {
    // Check if local client is connected via Convex query
    const connectionStatus = await this.convex.query(
      api.localSandbox.isConnected,
      { userId: this.userID }
    )

    if (connectionStatus.connected) {
      // Use local Convex sandbox
      if (!this.isLocal || !this.sandbox) {
        console.log(`[${this.userID}] Switching to local sandbox`)
        this.sandbox = new ConvexSandbox(
          this.userID,
          process.env.NEXT_PUBLIC_CONVEX_URL!
        )
        this.isLocal = true
        this.setSandboxCallback(this.sandbox)
      }

      return { sandbox: this.sandbox }
    } else {
      // Fall back to E2B
      if (this.isLocal || !this.sandbox) {
        console.log(`[${this.userID}] Switching to E2B sandbox`)
        this.sandbox = await Sandbox.create({
          apiKey: process.env.E2B_API_KEY!,
          timeoutMs: 15 * 60 * 1000
        })
        this.isLocal = false
        this.setSandboxCallback(this.sandbox)
      }

      return { sandbox: this.sandbox as Sandbox }
    }
  }

  setSandbox(sandbox: Sandbox | ConvexSandbox): void {
    this.sandbox = sandbox
    this.setSandboxCallback(sandbox)
  }
}
```

### Local Client Implementation

#### File: `scripts/local-sandbox-client.ts`

```typescript
#!/usr/bin/env node

import { ConvexClient } from 'convex/browser'
import { api } from '@/convex/_generated/api'
import { exec } from 'child_process'
import { promisify } from 'util'
import chalk from 'chalk'

const execAsync = promisify(exec)

interface Config {
  convexUrl: string
  token: string
  image: string
}

class LocalSandboxClient {
  private convex: ConvexClient
  private containerId?: string
  private userId?: string
  private heartbeatInterval?: NodeJS.Timeout
  private isShuttingDown = false
  private commandSubscriptionUnsubscribe?: () => void

  constructor(private config: Config) {
    this.convex = new ConvexClient(config.convexUrl)
  }

  async start() {
    console.log(chalk.blue('🚀 Starting HackerAI local sandbox...'))

    // Check Docker
    try {
      await execAsync('docker --version')
    } catch {
      console.error(chalk.red('❌ Docker not found. Please install Docker.'))
      process.exit(1)
    }

    // Create container
    this.containerId = await this.createContainer()
    console.log(chalk.green(`✓ Container: ${this.containerId.slice(0, 12)}`))

    // Connect to Convex
    await this.connect()
  }

  private async createContainer(): Promise<string> {
    console.log(chalk.blue('Creating Docker container...'))

    const { stdout } = await execAsync(
      `docker run -d --network host ${this.config.image} tail -f /dev/null`
    )

    const containerId = stdout.trim()

    // Install common tools
    console.log(chalk.blue('Installing tools...'))
    await execAsync(
      `docker exec ${containerId} apt-get update -qq 2>/dev/null || true`
    )
    await execAsync(
      `docker exec ${containerId} apt-get install -y curl wget nmap git python3 python3-pip -qq 2>/dev/null || true`
    )

    return containerId
  }

  private async connect() {
    console.log(chalk.blue('Connecting to Convex...'))

    try {
      // Authenticate via Convex mutation
      const result = await this.convex.mutation(api.localSandbox.connect, {
        token: this.config.token,
        containerId: this.containerId!,
        clientVersion: '1.0.0'
      })

      if (!result.success) {
        throw new Error('Authentication failed')
      }

      this.userId = result.userId
      console.log(chalk.green('✓ Authenticated'))
      console.log(chalk.green.bold('🎉 Local sandbox is ready!'))
      console.log(chalk.gray(`User ID: ${this.userId}`))

      // Start heartbeat
      this.startHeartbeat()

      // Subscribe to commands
      this.subscribeToCommands()
    } catch (error: any) {
      console.error(chalk.red('❌ Connection failed:'), error.message)
      console.error(
        chalk.yellow('Please regenerate your token in Settings')
      )
      await this.cleanup()
      process.exit(1)
    }
  }

  private subscribeToCommands() {
    if (!this.userId) return

    // Real-time subscription to pending commands
    this.commandSubscriptionUnsubscribe = this.convex.onUpdate(
      api.localSandbox.getPendingCommands,
      { userId: this.userId },
      async (data) => {
        if (data?.commands && data.commands.length > 0) {
          // Execute all pending commands
          for (const cmd of data.commands) {
            await this.executeCommand(cmd)
          }
        }
      }
    )
  }

  private async executeCommand(cmd: any) {
    const { command_id, command, env, cwd, timeout } = cmd
    const startTime = Date.now()

    console.log(chalk.cyan(`▶ Executing: ${command}`))

    try {
      // Mark as executing
      await this.convex.mutation(api.localSandbox.markCommandExecuting, {
        commandId: command_id
      })

      // Build command with env vars and cwd
      let fullCommand = command

      if (cwd) {
        fullCommand = `cd ${cwd} && ${fullCommand}`
      }

      if (env) {
        const envString = Object.entries(env)
          .map(([k, v]) => `export ${k}="${v}"`)
          .join('; ')
        fullCommand = `${envString}; ${fullCommand}`
      }

      // Execute in container
      const result = await execAsync(
        `docker exec ${this.containerId} bash -c "${fullCommand.replace(/"/g, '\\"')}"`,
        { timeout: timeout ?? 30000 }
      ).catch(error => ({
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        code: error.code || 1
      }))

      const duration = Date.now() - startTime

      // Submit result via Convex mutation
      await this.convex.mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.code || 0,
        duration
      })

      console.log(chalk.green(`✓ Command completed in ${duration}ms`))
    } catch (error: any) {
      const duration = Date.now() - startTime

      await this.convex.mutation(api.localSandbox.submitResult, {
        commandId: command_id,
        userId: this.userId!,
        stdout: '',
        stderr: error.message,
        exitCode: 1,
        duration
      })

      console.log(chalk.red(`✗ Command failed: ${error.message}`))
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      if (this.userId) {
        await this.convex.mutation(api.localSandbox.heartbeat, {
          userId: this.userId
        })
      }
    }, 10000) // Every 10 seconds
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }
  }

  async cleanup() {
    console.log(chalk.blue('\n🧹 Cleaning up...'))

    this.stopHeartbeat()

    if (this.commandSubscriptionUnsubscribe) {
      this.commandSubscriptionUnsubscribe()
    }

    if (this.userId) {
      await this.convex.mutation(api.localSandbox.disconnect, {
        userId: this.userId
      })
    }

    if (this.containerId) {
      try {
        await execAsync(`docker rm -f ${this.containerId}`)
        console.log(chalk.green('✓ Container removed'))
      } catch (error) {
        console.error(chalk.red('Error removing container:'), error)
      }
    }

    this.convex.close()
  }
}

// Parse command-line arguments
const args = process.argv.slice(2)
const getArg = (flag: string) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

const config = {
  convexUrl:
    getArg('--convex-url') ||
    process.env.NEXT_PUBLIC_CONVEX_URL ||
    '',
  token: getArg('--token') || process.env.HACKERAI_TOKEN || '',
  image: getArg('--image') || process.env.DOCKER_IMAGE || 'ubuntu:latest'
}

if (!config.token) {
  console.error(chalk.red('❌ No authentication token provided'))
  console.error(chalk.yellow('Usage: npx hackerai-local --token YOUR_TOKEN'))
  console.error(chalk.yellow('Or set HACKERAI_TOKEN environment variable'))
  process.exit(1)
}

if (!config.convexUrl) {
  console.error(chalk.red('❌ No Convex URL provided'))
  console.error(chalk.yellow('Set NEXT_PUBLIC_CONVEX_URL environment variable'))
  process.exit(1)
}

const client = new LocalSandboxClient(config)

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down...'))
  client['isShuttingDown'] = true
  await client.cleanup()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  client['isShuttingDown'] = true
  await client.cleanup()
  process.exit(0)
})

client.start().catch(error => {
  console.error(chalk.red('Fatal error:'), error)
  process.exit(1)
})
```

---

## Implementation Plan

### Phase 1: Convex Schema & Functions
1. Update `convex/schema.ts` with new tables
2. Implement `convex/localSandbox.ts` with all mutations/queries
3. Test token generation and verification

### Phase 2: ConvexSandbox
1. Implement `lib/ai/tools/utils/convex-sandbox.ts`
2. Test command queueing and result retrieval
3. Verify E2B-compatible interface

### Phase 3: HybridSandboxManager
1. Implement `lib/ai/tools/utils/hybrid-sandbox-manager.ts`
2. Update `lib/ai/tools/index.ts` to use HybridSandboxManager
3. Test automatic switching logic

### Phase 4: Local Client
1. Implement `scripts/local-sandbox-client.ts`
2. Test Docker container creation
3. Test Convex authentication
4. Test command subscription and execution

### Phase 5: UI Components
1. Update `app/components/SettingsDialog.tsx`
2. Implement `app/components/LocalSandboxTab.tsx`
3. Test connection status display
4. Test token management

### Phase 6: Testing & Deployment
1. End-to-end testing
2. Performance testing
3. Deploy to Vercel
4. Monitor Convex usage

---

## User Experience

### First-Time Setup

```
1. User opens app → Settings → Local Sandbox

2. Sees status:
   ⚪ Cloud Sandbox (E2B)
   Run the local client to enable local execution

3. User clicks "Copy" button next to command:
   npx hackerai-local --token hsb_abc123def456...

4. User pastes in terminal, presses Enter

5. Client output:
   🚀 Starting HackerAI local sandbox...
   ✓ Docker is available
   Creating Docker container...
   ✓ Container: a1b2c3d4e5f6
   Installing tools...
   Connecting to Convex...
   ✓ Authenticated
   🎉 Local sandbox is ready!

6. UI automatically updates (real-time via Convex):
   🟢 Local Sandbox Connected
   Commands running on your local machine

7. User starts chatting - all commands execute locally!
```

---

## Security Model

### Authentication Flow

```
1. User generates token in UI
   → Convex stores: { user_id: "user_123", local_sandbox_token: "hsb_..." }

2. Client connects with token
   → Convex mutation verifies token and creates connection record

3. All subsequent commands authenticated by userId
   → Commands queued with userId, only visible to that user
```

### Authorization

- **One connection per user**: New connection replaces old one
- **User isolation**: Commands filtered by userId in queries
- **No cross-user access**: Convex indexes ensure data isolation

---

## Performance Specifications

### Latency Targets

```
Command delivery:     < 100ms  (Convex subscription)
Result return:        < 100ms  (Convex subscription)
Total overhead:       < 200ms  (excluding command execution)
Disconnect detection: 30s      (heartbeat timeout)
```

### Scalability

- Convex handles all real-time subscriptions efficiently
- No in-memory state on application server
- Works perfectly with Vercel's serverless architecture
- Scales horizontally with Convex backend

---

## Deployment Guide

### Environment Variables

```env
# .env.local

# Convex (already configured)
NEXT_PUBLIC_CONVEX_URL=https://...
CONVEX_DEPLOYMENT=...

# E2B (already configured)
E2B_API_KEY=...
```

### Deploy to Vercel

```bash
git push origin main
# Vercel auto-deploys
```

### Convex Scheduled Functions

```bash
# Add to convex/cron.config.ts
npx convex dev
```

---

## Cost Analysis & ROI

### Current E2B Costs

**Monthly spending:**
- E2B subscription: $150/month
- E2B usage (auto-pause): ~$300/month ($10/day)
- **Total: $450/month** (~$5,400/year)

**Per-user costs:**
- Heavy users: ~$10-30/month
- Medium users: ~$2-5/month
- Light users: ~$0.50-1/month

### Local Sandbox Costs

**Infrastructure:**
- Convex: Already included in existing plan ($0 additional)
- Vercel: Already included in existing plan ($0 additional)
- User's hardware: $0 (user-provided)

**Monthly spending:**
- E2B subscription: $150/month (for cloud fallback)
- E2B usage: ~$30-50/month (10-15% of users use E2B)
- **Total: $180-200/month** (~$2,160-2,400/year)

### ROI Calculation

**Monthly savings:**
- Current: $450/month
- New: $200/month
- **Savings: $250/month** ($3,000/year)

**Break-even:**
- Development time: ~2-3 weeks
- Assuming $100/hour: ~$8,000-12,000 cost
- **Break-even: 2.5-4 months**

**Long-term benefits:**
- Year 1 savings: ~$0 (after dev costs)
- Year 2+ savings: ~$3,000/year
- 5-year savings: ~$12,000-15,000

**Additional benefits:**
- Users with local network access
- Users with specialized hardware (GPUs, USB devices)
- Users with compliance requirements (data locality)
- Users with custom OS environments

### Usage Projections

**Estimated local vs cloud split:**
- 70-80% of commands run locally
- 20-30% of commands run on E2B (users without local setup)
- Free tier users: mostly local (avoid E2B costs)
- Pro/Ultra users: mix of local and cloud

**E2B usage reduction:**
```
Before: 100% of commands → E2B
After:  20-30% of commands → E2B
Result: 70-80% cost reduction
```

---

## UI Components

### Sandbox Selector (New Chat)

Similar to Cursor's model selector:

```typescript
// app/components/SandboxSelector.tsx

'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Check, Cloud, Laptop, AlertTriangle } from 'lucide-react'

export function SandboxSelector({ userId, value, onChange }: {
  userId: string
  value: string
  onChange: (value: string) => void
}) {
  const connections = useQuery(api.localSandbox.listConnections, { userId })

  const options = [
    {
      id: 'e2b',
      label: 'E2B Cloud',
      icon: Cloud,
      description: 'Auto-pause, $10/day',
      warning: null
    },
    ...(connections?.map(conn => ({
      id: conn.connectionId,
      label: conn.name,
      icon: Laptop,
      description: conn.mode === 'dangerous'
        ? `Dangerous: ${conn.osInfo?.platform}`
        : `Docker: ${conn.containerId?.slice(0, 12)}`,
      warning: conn.mode === 'dangerous'
        ? 'Direct OS access - no isolation'
        : null
    })) || [])
  ]

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Execution Environment</label>
      <div className="space-y-1">
        {options.map(option => (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`
              w-full flex items-center gap-3 p-3 rounded border
              ${value === option.id
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted'
              }
            `}
          >
            <option.icon className="h-4 w-4" />
            <div className="flex-1 text-left">
              <div className="font-medium">{option.label}</div>
              <div className="text-xs text-muted-foreground">
                {option.description}
              </div>
              {option.warning && (
                <div className="text-xs text-yellow-600 dark:text-yellow-400 flex items-center gap-1 mt-1">
                  <AlertTriangle className="h-3 w-3" />
                  {option.warning}
                </div>
              )}
            </div>
            {value === option.id && (
              <Check className="h-4 w-4 text-primary" />
            )}
          </button>
        ))}
      </div>
      {connections && connections.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No local connections. Run{' '}
          <code className="bg-muted px-1 rounded">npx hackerai-local</code>
          {' '}to enable local execution.
        </p>
      )}
    </div>
  )
}
```

### Local Sandbox Settings

Updated with multiple connections support:

```typescript
// app/components/LocalSandboxTab.tsx

'use client'

import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { Button } from '@/components/ui/button'
import { Circle, Copy, AlertTriangle } from 'lucide-react'

export function LocalSandboxTab({ userId }: { userId: string }) {
  const connections = useQuery(api.localSandbox.listConnections, { userId })
  const token = useQuery(api.localSandbox.getToken, { userId })

  return (
    <div className="space-y-6 p-6">
      {/* Active Connections */}
      <div>
        <h3 className="font-semibold mb-3">Active Connections</h3>
        {connections && connections.length > 0 ? (
          <div className="space-y-2">
            {connections.map(conn => (
              <div
                key={conn.connectionId}
                className="flex items-center gap-3 p-3 border rounded"
              >
                <Circle className="h-3 w-3 fill-green-500 text-green-500" />
                <div className="flex-1">
                  <div className="font-medium">{conn.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {conn.mode === 'docker'
                      ? `Docker: ${conn.containerId?.slice(0, 12)}`
                      : `Dangerous: ${conn.osInfo?.platform} ${conn.osInfo?.arch}`
                    }
                  </div>
                </div>
                {conn.mode === 'dangerous' && (
                  <AlertTriangle className="h-4 w-4 text-yellow-500" />
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="p-4 border rounded text-center text-muted-foreground">
            <Circle className="h-3 w-3 fill-gray-400 text-gray-400 mx-auto mb-2" />
            <p>No active connections</p>
            <p className="text-sm">Run the command below to connect</p>
          </div>
        )}
      </div>

      {/* Quick Setup */}
      <div className="space-y-4">
        <h3 className="font-semibold">Setup Commands</h3>

        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium mb-1">Basic (Docker)</div>
            <code className="text-xs bg-muted p-2 rounded block">
              npx hackerai-local --token {token?.token} --name "My Laptop"
            </code>
          </div>

          <div>
            <div className="text-sm font-medium mb-1">Custom Image (Kali Linux)</div>
            <code className="text-xs bg-muted p-2 rounded block">
              npx hackerai-local --token {token?.token} --name "Kali" --image kalilinux/kali-rolling
            </code>
          </div>

          <div>
            <div className="text-sm font-medium mb-1 flex items-center gap-2">
              Dangerous Mode (No Docker)
              <AlertTriangle className="h-3 w-3 text-yellow-500" />
            </div>
            <code className="text-xs bg-muted p-2 rounded block">
              npx hackerai-local --token {token?.token} --name "Work PC" --dangerous
            </code>
            <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
              ⚠️ Commands run directly on host OS - no isolation
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
```

---

## Next Steps

1. Update Convex schema
2. Implement Convex functions
3. Implement ConvexSandbox
4. Update HybridSandboxManager
5. Implement local client
6. Update UI components
7. Test end-to-end
8. Deploy to Vercel

---

**Document Version**: 4.0.0
**Last Updated**: 2025-11-24
**Status**: Ready for Implementation
**Architecture**: Convex Real-Time (WebSocket-backed)
**New Features**: Multiple Connections, Dangerous Mode, Chat-Level Selector, Cost Analysis
