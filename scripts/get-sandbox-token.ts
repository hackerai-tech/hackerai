#!/usr/bin/env node

/**
 * Get Sandbox Token CLI
 *
 * Gets your local sandbox auth token without needing to open the UI.
 * Requires a valid session cookie.
 */

import * as readline from "readline";

async function getToken(backendUrl: string, sessionCookie?: string): Promise<void> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (sessionCookie) {
      headers["Cookie"] = sessionCookie;
    }

    const response = await fetch(`${backendUrl}/api/local-sandbox/token`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        console.error("❌ Unauthorized. You need to:");
        console.error("   1. Log in to the web app");
        console.error("   2. Get your token from Settings → Local Sandbox");
        console.error("\nOr provide your session cookie:");
        console.error("   npm run get-token -- --session 'your-cookie'");
        process.exit(1);
      }
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    console.log("\n✅ Your local sandbox token:\n");
    console.log(data.token);
    console.log("\n📋 To use it, run:\n");
    console.log(`npm run local-sandbox -- --auth-token ${data.token}\n`);
  } catch (error) {
    console.error("❌ Failed to get token:", error);
    console.error("\n💡 Alternative: Get your token from the UI:");
    console.error("   1. Open http://localhost:3000");
    console.error("   2. Go to Settings → Local Sandbox");
    console.error("   3. Copy the token");
    process.exit(1);
  }
}

// Parse args
const args = process.argv.slice(2);
let backendUrl = process.env.BACKEND_URL || "http://localhost:3000";
let sessionCookie: string | undefined;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--backend-url":
      backendUrl = args[++i];
      break;
    case "--session":
      sessionCookie = args[++i];
      break;
    case "--help":
      console.log(`
Get Local Sandbox Token

Usage:
  npm run get-token
  npm run get-token -- --session 'your-session-cookie'

Options:
  --backend-url URL    Backend URL (default: http://localhost:3000)
  --session COOKIE     Session cookie from browser (optional)
  --help              Show this help

Note: If you don't provide a session cookie, you'll need to get your
token from the web UI at Settings → Local Sandbox.
      `);
      process.exit(0);
  }
}

getToken(backendUrl, sessionCookie);
