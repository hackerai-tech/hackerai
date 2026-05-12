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
