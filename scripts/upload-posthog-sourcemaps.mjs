import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

for (const envFile of [".env.local", ".env"]) {
  if (existsSync(envFile)) {
    loadDotenv({ path: envFile, quiet: true });
  }
}

const buildDirectory = ".next";
const apiKey = process.env.POSTHOG_CLI_API_KEY?.trim();
const projectId = process.env.POSTHOG_CLI_PROJECT_ID?.trim();
const host = process.env.POSTHOG_CLI_HOST?.trim();
const hasApiKey = Boolean(apiKey);
const hasProjectId = Boolean(projectId);
const failOnError =
  process.env.POSTHOG_SOURCEMAP_UPLOAD_STRICT?.trim().toLowerCase() === "true";

if (!hasApiKey && !hasProjectId) {
  console.log(
    "[PostHog] Skipping source map upload. Set POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID to enable it.",
  );
  process.exit(0);
}

if (!hasApiKey || !hasProjectId) {
  const message =
    "[PostHog] Source map upload requires both POSTHOG_CLI_API_KEY and POSTHOG_CLI_PROJECT_ID.";
  if (failOnError) {
    console.error(message);
    process.exit(1);
  }
  console.warn(`${message} Skipping upload.`);
  process.exit(0);
}

if (!existsSync(buildDirectory)) {
  console.error(`[PostHog] Build directory not found: ${buildDirectory}`);
  process.exit(1);
}

const releaseName =
  process.env.POSTHOG_SOURCEMAP_RELEASE_NAME?.trim() ||
  readPackageName() ||
  "hackerai";
const releaseVersion =
  process.env.POSTHOG_SOURCEMAP_RELEASE_VERSION?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  readGitCommit();
const build =
  process.env.POSTHOG_SOURCEMAP_BUILD?.trim() ||
  process.env.VERCEL_DEPLOYMENT_ID?.trim();

const args = [
  ...(host ? ["--host", host] : []),
  "sourcemap",
  "process",
  "--directory",
  buildDirectory,
  "--release-name",
  releaseName,
  "--delete-after",
];

if (releaseVersion) {
  args.push("--release-version", releaseVersion);
}

if (build) {
  args.push("--build", build);
}

const result = spawnSync("posthog-cli", args, {
  env: process.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[PostHog] Failed to run posthog-cli: ${result.error.message}`);
  process.exit(failOnError ? 1 : 0);
}

if (result.status !== 0) {
  console.error(
    `[PostHog] Source map upload failed with exit code ${result.status ?? 1}.`,
  );
  if (!failOnError) {
    console.warn(
      "[PostHog] Continuing build because source map upload is best-effort. Set POSTHOG_SOURCEMAP_UPLOAD_STRICT=true to fail on upload errors.",
    );
    process.exit(0);
  }
}

process.exit(result.status ?? 1);

function readPackageName() {
  try {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    return typeof packageJson.name === "string"
      ? packageJson.name.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function readGitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) return undefined;

  return result.stdout.trim() || undefined;
}
