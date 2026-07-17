const buildEnvironmentKeys = [
  "POSTHOG_CLI_API_KEY",
  "POSTHOG_CLI_PROJECT_ID",
  "VERCEL_ENV",
] as const;

const originalBuildEnvironment = Object.fromEntries(
  buildEnvironmentKeys.map((key) => [key, process.env[key]]),
);

async function loadNextConfig(environment: Record<string, string>) {
  jest.resetModules();

  for (const key of buildEnvironmentKeys) {
    delete process.env[key];
  }
  Object.assign(process.env, environment);

  return (await import("../next.config")).default;
}

afterAll(() => {
  for (const key of buildEnvironmentKeys) {
    const originalValue = originalBuildEnvironment[key];
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
});

describe("Next.js build settings", () => {
  test("enables source maps and type checking for Vercel production", async () => {
    const config = await loadNextConfig({
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "project_test",
      VERCEL_ENV: "production",
    });

    expect(config.productionBrowserSourceMaps).toBe(true);
    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });

  test("disables source maps and skips duplicate type checking for previews", async () => {
    const config = await loadNextConfig({
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "project_test",
      VERCEL_ENV: "preview",
    });

    expect(config.productionBrowserSourceMaps).toBe(false);
    expect(config.typescript?.ignoreBuildErrors).toBe(true);
  });

  test("keeps local builds type-safe without uploading source maps", async () => {
    const config = await loadNextConfig({
      POSTHOG_CLI_API_KEY: "phx_test",
      POSTHOG_CLI_PROJECT_ID: "project_test",
    });

    expect(config.productionBrowserSourceMaps).toBe(false);
    expect(config.typescript?.ignoreBuildErrors).toBe(false);
  });
});
