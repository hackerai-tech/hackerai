import { config } from "dotenv";
import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages } from "@trigger.dev/build/extensions/core";

if (process.env.NODE_ENV !== "production") {
  config({ path: ".env.local" });
}

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID!,
  // centrifuge-js relies on globalThis.WebSocket, which is only stable on
  // Node 22+. The default "node" runtime is older and would throw
  // "WebSocket constructor not found" when CentrifugoSandbox connects.
  runtime: "node-22",
  logLevel: "log",
  // Up to four hours per agent-long run. The task stops active work slightly
  // earlier so cleanup can finish before Trigger.dev enforces this ceiling.
  maxDuration: 4 * 60 * 60,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ["./trigger"],
  build: {
    autoDetectExternal: true,
    keepNames: true,
    minify: false,
    // Native modules that must be installed at deploy time, not bundled.
    // @e2b/code-interpreter is pure JS and intentionally NOT listed here —
    // bundling it lets esbuild convert chalk's ESM to CJS inline, avoiding
    // the ERR_REQUIRE_ESM crash that occurs when Docker installs it via npm.
    external: ["node-pty", "sharp"],
    extensions: [
      additionalPackages({
        packages: ["node-pty", "sharp"],
      }),
    ],
  },
});
