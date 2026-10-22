import { parseCliOptions } from "../cli-options";

describe("CLI startup validation", () => {
  it("preserves generated connection arguments and quoted names", () => {
    expect(
      parseCliOptions([
        "--token",
        "test-token",
        "--name",
        "Work PC",
        "--convex-url",
        "http://127.0.0.1:3210",
      ]),
    ).toEqual({
      token: "test-token",
      name: "Work PC",
      convexUrl: "http://127.0.0.1:3210",
    });
  });

  it("does not mistake the next flag for a token", () => {
    expect(() => parseCliOptions(["--token", "--name", "Work PC"])).toThrow(
      "Missing value for --token",
    );
  });

  it.each([
    [],
    ["--token"],
    ["--token", ""],
    ["--token", "test-token", "--name"],
    ["--token", "test-token", "--convex-url"],
    ["--token", "test-token", "--token", "another-token"],
    ["--token", "test-token", "--bogus"],
  ])("rejects incomplete or ambiguous arguments: %j", (...args: string[]) => {
    expect(() => parseCliOptions(args)).toThrow();
  });

  it.each([
    ["--tokne", "sensitive-value"],
    ["sensitive-value"],
    [
      "--token",
      "test-token",
      "--convex-url",
      "https://user:sensitive-value@example.com",
    ],
    ["--token", "test-token", "--convex-url", "sensitive-value"],
  ])(
    "does not echo credentials from rejected input: %j",
    (...args: string[]) => {
      try {
        parseCliOptions(args);
        throw new Error("Expected argument validation to fail");
      } catch (error) {
        expect((error as Error).message).not.toContain("sensitive-value");
        expect((error as Error).message).not.toContain(
          "Expected argument validation",
        );
      }
    },
  );
});
