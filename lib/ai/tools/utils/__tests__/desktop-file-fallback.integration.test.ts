import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentrifugoSandbox } from "../centrifugo-sandbox";
import { verifyEvidenceReferences } from "@/lib/ai/subagents/evidence-references";

jest.mock("@/lib/centrifugo/jwt", () => ({
  generateCentrifugoToken: jest.fn(),
}));

// Exercise generated file commands on a real filesystem, using zsh on macOS
// (the failing desktop journey) and bash on Linux CI. No relay or API credentials.
const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";

describe("desktop files after a failed native bridge probe", () => {
  it("writes and reads literal text, then verifies subagent evidence through the same host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hackerai-file-fallback-"));
    const sandbox = new CentrifugoSandbox(
      "test-user",
      {
        connectionId: "test-desktop",
        name: "test-desktop",
        isDesktop: true,
        osInfo: {
          platform: process.platform,
          arch: process.arch,
          release: "test",
          hostname: "test",
        },
        capabilities: { commands: true, pty: true, files: false },
      },
      { wsUrl: "ws://unused", tokenSecret: "unused" },
    );
    jest
      .spyOn(sandbox.commands, "run")
      .mockImplementation(async (command, options) => ({
        stdout: execFileSync(shell, ["-c", command], {
          encoding: "utf8",
          env: { ...process.env, ...options?.envVars },
          timeout: 5_000,
        }),
        stderr: "",
        exitCode: 0,
      }));
    const stat = jest.spyOn(sandbox.files, "stat");
    const path = join(dir, "evidence 'quoted' [1].txt");
    const marker = join(dir, "must-not-exist");
    const text = `literal 'quotes' $HOME $(touch ${marker}) \`touch ${marker}\`\nsecond line`;
    try {
      await sandbox.files.write(path, text);
      expect(readFileSync(path, "utf8")).toBe(text);
      await sandbox.files.append(path, "\nappend\n");
      expect(await sandbox.files.read(path)).toBe(text + "\nappend\n");
      expect(existsSync(marker)).toBe(false);
      const result = await verifyEvidenceReferences({
        sandbox,
        refs: [path],
        expectedSandboxIdentity: "connection:test-desktop",
        signal: new AbortController().signal,
        authorize: async () => {},
      });
      expect(result).toMatchObject({
        accepted: true,
        evidence_refs: [path],
        evidence_verification: { checked_refs: [path], unavailable_refs: [] },
      });
      expect(stat).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
