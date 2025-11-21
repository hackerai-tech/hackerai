import { NextRequest, NextResponse } from "next/server";
import { fetchQuery, fetchMutation } from "convex/nextjs";
import { api } from "@/convex/_generated/api";

// Store for pending commands and results
// In production, use Redis or similar
const pendingCommands = new Map<
  string,
  Array<{ id: string; command: string; options: any }>
>();
const commandResults = new Map<string, any>();

async function getUserIdFromRequest(request: NextRequest): Promise<string | null> {
  let userId: string | null = null;

  // Try to get userId from WorkOS session first
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(request);
    userId = session?.user?.id || null;
  } catch {
    // Session check failed, will try token auth
  }

  // If no session, try token auth (for local client)
  if (!userId) {
    const authHeader = request.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7);

      // Verify token via Convex
      try {
        const result = await fetchQuery(api.localSandbox.verifyToken, { token });
        if (result.valid) {
          userId = result.userId;
        }
      } catch (error) {
        console.error("Token verification error:", error);
      }
    }
  }

  return userId;
}

export async function POST(request: NextRequest) {
  const userId = await getUserIdFromRequest(request);

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { type, data } = body;

  console.log(`[POST /api/local-sandbox] Type: ${type}, UserId: ${userId}`);

  switch (type) {
    case "connect": {
      // Local client registers itself
      const { containerId, mode = "docker" } = data;

      try {
        const result = await fetchMutation(api.localSandbox.connect, {
          userId,
          containerId,
          mode: "docker",
        });

        pendingCommands.set(userId, []);

        return NextResponse.json({
          success: true,
          containerId,
          mode,
          disconnectedOld: result.disconnectedOld,
        });
      } catch (error) {
        console.error("Connection error:", error);
        return NextResponse.json(
          { error: "Failed to connect" },
          { status: 500 }
        );
      }
    }

    case "poll": {
      // Local client polls for commands
      // Atomically get and clear commands to avoid race conditions
      const commands = pendingCommands.get(userId) || [];
      const queueSize = commands.length;

      // Log every 10th poll or when commands exist to track polling activity
      const shouldLog = queueSize > 0 || Math.random() < 0.1; // 10% of empty polls

      if (shouldLog) {
        console.log(`[poll] User ${userId} polling, queue size: ${queueSize}`);
        if (queueSize === 0) {
          console.log(`[poll] Available queues:`, Array.from(pendingCommands.entries()).map(([uid, cmds]) => ({ userId: uid, count: cmds.length })));
        }
      }

      if (commands.length > 0) {
        console.log(`[poll] Returning ${commands.length} commands:`, commands.map(c => ({ id: c.id, cmd: c.command.substring(0, 50) })));
        pendingCommands.set(userId, []); // Only clear if we're returning commands
      }

      // Update last ping
      try {
        await fetchMutation(api.localSandbox.ping, { userId });
      } catch (error) {
        console.error("Ping error:", error);
      }

      return NextResponse.json({
        commands,
      });
    }

    case "result": {
      // Local client sends command result
      const { requestId, result } = data;
      commandResults.set(requestId, result);

      // Auto-cleanup after 1 minute
      setTimeout(() => {
        commandResults.delete(requestId);
      }, 60000);

      return NextResponse.json({ success: true });
    }

    case "disconnect": {
      try {
        await fetchMutation(api.localSandbox.disconnect, { userId });
      } catch (error) {
        console.error("Disconnect error:", error);
      }

      pendingCommands.delete(userId);

      return NextResponse.json({ success: true });
    }

    default:
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromRequest(request);

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const status = await fetchMutation(api.localSandbox.getConnectionStatus, { userId });
    return NextResponse.json(status);
  } catch (error) {
    console.error("Status check error:", error);
    return NextResponse.json({
      connected: false,
      lastPing: null,
      mode: null,
    });
  }
}

/**
 * Internal API for sandbox manager to send commands
 */
export function queueCommand(userId: string, command: {
  id: string;
  command: string;
  options: any;
}): void {
  console.log(`[queueCommand] Queueing command for userId: ${userId}`);
  console.log(`[queueCommand] Command ID: ${command.id}, Command: ${command.command.substring(0, 100)}`);

  const queue = pendingCommands.get(userId) || [];
  queue.push(command);
  pendingCommands.set(userId, queue);

  console.log(`[queueCommand] Queue size for user ${userId}: ${queue.length}`);
  console.log(`[queueCommand] All users in pendingCommands: ${Array.from(pendingCommands.keys()).join(', ')}`);
}

/**
 * Internal API for sandbox manager to get results
 */
export function getCommandResult(requestId: string): any {
  return commandResults.get(requestId);
}
