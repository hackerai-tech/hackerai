import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";

export const maxDuration = 60;

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { pid, command } = body;

    if (!pid || typeof pid !== "number") {
      return new Response(JSON.stringify({ error: "Invalid PID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!command || typeof command !== "string") {
      return new Response(JSON.stringify({ error: "Invalid command" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Find the user's sandbox
    const paginator = Sandbox.list({
      query: {
        metadata: {
          userID: userId,
          template: SANDBOX_TEMPLATE,
        },
      },
    });

    const existingSandbox = (await paginator.nextItems())[0];

    if (!existingSandbox) {
      // No sandbox exists, process definitely not running
      return new Response(
        JSON.stringify({
          running: false,
          pid,
          command,
          message: "No active sandbox found",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Connect to the sandbox
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.connect(existingSandbox.sandboxId);
    } catch (error) {
      return new Response(
        JSON.stringify({
          running: false,
          pid,
          command,
          message: "Could not connect to sandbox",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Check if process is running using ps command with full command line
    try {
      // Get PID and full command line arguments
      const result = await sandbox.commands.run(
        `ps -p ${pid} -o pid,args --no-headers`,
        {
          user: "root" as const,
          cwd: "/home/user",
        },
      );

      // Process exists if we got output
      const output = result.stdout.trim();

      if (!output) {
        return new Response(
          JSON.stringify({
            running: false,
            pid,
            command,
            message: "Process not found",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // Extract the command from ps output (format: "PID COMMAND")
      const parts = output.split(/\s+/, 2);
      const processCommand = output.substring(parts[0].length).trim();

      // Verify the command matches (check if the process command contains our command)
      // This handles cases where command might have additional flags or be wrapped
      const commandMatches = processCommand.includes(command) ||
                            command.includes(processCommand.split(/\s+/)[0]);

      if (!commandMatches) {
        return new Response(
          JSON.stringify({
            running: false,
            pid,
            command,
            message: `PID exists but running different command: ${processCommand}`,
            actualCommand: processCommand,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          running: true,
          pid,
          command,
          actualCommand: processCommand,
          message: "Process is running",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (error) {
      // ps command error usually means process doesn't exist
      return new Response(
        JSON.stringify({
          running: false,
          pid,
          command,
          message: "Process not found",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  } catch (error) {
    // Handle authentication errors with proper 401 status
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error("Error checking process status:", error);
    return new Response(
      JSON.stringify({ error: "Failed to check process status" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
