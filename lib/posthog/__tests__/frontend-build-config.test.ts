describe("frontend build identity configuration", () => {
  const originalVercelCommit = process.env.VERCEL_GIT_COMMIT_SHA;
  const originalGitHubCommit = process.env.GITHUB_SHA;

  afterEach(() => {
    for (const [key, value] of [
      ["VERCEL_GIT_COMMIT_SHA", originalVercelCommit],
      ["GITHUB_SHA", originalGitHubCommit],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([
    ["A".repeat(40), "b".repeat(40), "a".repeat(40)],
    [undefined, "b".repeat(40), "b".repeat(40)],
    [undefined, undefined, ""],
    ["not-a-commit", "b".repeat(40), ""],
  ])(
    "exposes only a valid build-time commit (%s)",
    (vercel, github, expected) => {
      if (vercel === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = vercel;
      if (github === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = github;

      jest.isolateModules(() => {
        const config = require("../../../next.config").default as {
          env: Record<string, string>;
        };
        expect(config.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT).toBe(expected);
      });
    },
  );
});
