import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const next = require.resolve("next/dist/bin/next");
const nativeCompiler = resolve(
  dirname(require.resolve("typescript-build/package.json")),
  "bin/tsc",
);

function run(script, args, env) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  if (result.error || result.signal || result.status !== 0)
    process.exit(result.status || 1);
}

const env = { ...process.env };
delete env.HACKERAI_BUILD_TYPECHECKED;

// Preview already has an independent required TypeScript 6 CI check.
if (env.VERCEL_ENV !== "preview") {
  run(next, ["typegen"], env);
  mkdirSync(resolve(root, ".next/cache"), { recursive: true });
  const startedAt = performance.now();
  console.log("[build] Checking the project with TypeScript 7...");
  run(
    nativeCompiler,
    [
      "--project",
      "tsconfig.json",
      "--noEmit",
      "--tsBuildInfoFile",
      ".next/cache/native-typescript.tsbuildinfo",
    ],
    env,
  );
  console.log(
    `[build] TypeScript 7 passed in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  // Only this child may skip Next's duplicate check after the native CLI passes.
  env.HACKERAI_BUILD_TYPECHECKED = "1";
}
run(next, ["build"], env);
