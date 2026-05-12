import { defineConfig } from "@trigger.dev/sdk";
import { additionalPackages } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: "proj_fixirhycbcnfdpicejfb",
  runtime: "node",
  logLevel: "log",
  // Up to one hour per agent-long run.
  maxDuration: 3600,
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
    // Native modules pulled in by tool dependencies (PTY sessions, sharp via
    // file processing, etc.) must be installed at deploy time, not bundled.
    external: ["node-pty", "sharp", "@e2b/code-interpreter"],
    extensions: [
      additionalPackages({
        packages: ["node-pty", "sharp"],
      }),
    ],
  },
});
