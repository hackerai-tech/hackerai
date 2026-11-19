import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCliOptions, readProtectedTokenFile } from "../cli-options";

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

  it("accepts exactly one protected token-file source", () => {
    expect(
      parseCliOptions(["--token-file", "/run/secrets/remote-token"]),
    ).toMatchObject({ tokenFile: "/run/secrets/remote-token" });
    expect(() =>
      parseCliOptions([
        "--token",
        "test-token",
        "--token-file",
        "/run/secrets/remote-token",
      ]),
    ).toThrow("Provide exactly one token source");
  });

  it("reads a private regular token file and rejects unsafe replacements", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "hackerai-token-test-"),
    );
    const tokenFile = path.join(directory, "token");
    const symlink = path.join(directory, "token-link");
    try {
      const token = `hsb_${"a".repeat(64)}`;
      fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
      if (process.platform === "win32") {
        expect(() => readProtectedTokenFile(tokenFile)).toThrow(
          "Unable to read a private",
        );
        return;
      }
      expect(readProtectedTokenFile(tokenFile)).toBe(token);
      fs.symlinkSync(tokenFile, symlink);
      expect(() => readProtectedTokenFile(symlink)).toThrow(
        "Unable to read a private",
      );
      fs.chmodSync(tokenFile, 0o644);
      expect(() => readProtectedTokenFile(tokenFile)).toThrow(
        "Unable to read a private",
      );
      fs.chmodSync(tokenFile, 0o600);
      fs.writeFileSync(tokenFile, "invalid-token", { mode: 0o600 });
      expect(() => readProtectedTokenFile(tokenFile)).toThrow(
        "Unable to read a private",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
