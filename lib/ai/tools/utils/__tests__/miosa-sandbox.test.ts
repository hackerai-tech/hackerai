import { MiosaSandbox, isMiosaSandbox } from "../miosa-sandbox";

/**
 * The adapter's job is to satisfy `CommonSandboxInterface` faithfully. What is
 * worth asserting is the places the two contracts do NOT line up, because those
 * are where a wrong answer is silent.
 */

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function fakeSandbox(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    id: "sbx_test",
    exec: {
      run: jest.fn(
        async (command: string, options?: any): Promise<ExecResult> => {
          calls.push({ command, options });
          return { stdout: "ok", stderr: "", exitCode: 0, exit_code: 0 } as any;
        },
      ),
      stream: jest.fn(),
    },
    files: {
      write: jest.fn(async () => undefined),
      readText: jest.fn(async () => "contents"),
      list: jest.fn(async () => [{ name: "a.txt" }, { name: "b.txt" }]),
    },
    expose: jest.fn(async (port: number) => `https://p${port}.miosa.app/`),
    destroy: jest.fn(async () => undefined),
    ...overrides,
  };
}

function build(sandbox: any): MiosaSandbox {
  // The constructor is private by design; tests build through it directly
  // rather than reaching the network in create().
  return new (MiosaSandbox as any)({}, sandbox, sandbox.id);
}

describe("MiosaSandbox", () => {
  describe("discriminant", () => {
    it("identifies itself so call sites can branch like they do for Centrifugo", () => {
      expect(isMiosaSandbox(build(fakeSandbox()))).toBe(true);
    });

    it("does not claim unrelated objects", () => {
      expect(isMiosaSandbox(null)).toBe(false);
      expect(isMiosaSandbox({})).toBe(false);
      expect(isMiosaSandbox({ sandboxKind: "centrifugo" })).toBe(false);
    });
  });

  describe("commands.run", () => {
    it("passes cwd and env straight through", async () => {
      const fake = fakeSandbox();
      const sandbox = build(fake);

      await sandbox.commands.run("nmap --version", {
        cwd: "/home/user",
        envVars: { FOO: "bar" },
      });

      expect(fake.calls[0].options).toMatchObject({
        cwd: "/home/user",
        env: { FOO: "bar" },
      });
    });

    it("rounds a millisecond timeout UP to whole seconds", async () => {
      // Rounding down would cut a command short of the budget the caller asked
      // for - a 1500ms request must not become a 1s limit.
      const fake = fakeSandbox();
      const sandbox = build(fake);

      await sandbox.commands.run("sleep 2", { timeoutMs: 1500 });
      expect(fake.calls[0].options.timeoutSec).toBe(2);
    });

    it("never rounds a sub-second timeout down to zero", async () => {
      const fake = fakeSandbox();
      const sandbox = build(fake);

      await sandbox.commands.run("true", { timeoutMs: 10 });
      expect(fake.calls[0].options.timeoutSec).toBe(1);
    });

    it("normalises exit_code and exitCode to one field", async () => {
      const fake = fakeSandbox({
        exec: {
          run: jest.fn(async () => ({
            stdout: "",
            stderr: "boom",
            exit_code: 3,
          })),
          stream: jest.fn(),
        },
      });

      const result = await build(fake).commands.run("false");
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("boom");
    });
  });

  describe("getHost", () => {
    it("throws for an unresolved port instead of inventing a URL", async () => {
      // A fabricated host fails later, somewhere else, and reads as a network
      // fault rather than a missing prewarm.
      const sandbox = build(fakeSandbox());
      expect(() => sandbox.getHost(3000)).toThrow("has not been resolved");
    });

    it("returns a bare host once the port is warmed", async () => {
      const sandbox = build(fakeSandbox());
      await sandbox.prewarmHost(8080);

      // No scheme, no trailing slash - E2B's getHost returns a host, not a URL.
      expect(sandbox.getHost(8080)).toBe("p8080.miosa.app");
    });
  });

  describe("files", () => {
    it("reads text through the SDK's text accessor", async () => {
      const fake = fakeSandbox();
      await expect(build(fake).files.read("/tmp/x")).resolves.toBe("contents");
      expect(fake.files.readText).toHaveBeenCalledWith("/tmp/x");
    });

    it("normalises listings to { name }", async () => {
      const entries = await build(fakeSandbox()).files.list("/home/user");
      expect(entries).toEqual([{ name: "a.txt" }, { name: "b.txt" }]);
    });

    it("remove raises on a non-zero exit rather than resolving silently", async () => {
      // Resolving here would report a file as deleted when it is still there.
      const fake = fakeSandbox({
        exec: {
          run: jest.fn(async () => ({
            stdout: "",
            stderr: "permission denied",
            exitCode: 1,
          })),
          stream: jest.fn(),
        },
      });

      await expect(build(fake).files.remove("/tmp/x")).rejects.toThrow(
        "permission denied",
      );
    });

    it("quotes paths so a space or quote cannot break the shell call", async () => {
      const fake = fakeSandbox();
      await build(fake).files.remove("/tmp/a file's name.txt");

      const command: string = fake.calls[0].command;
      expect(command).toContain("rm -f --");
      // The embedded quote must be escaped, not terminating the argument.
      expect(command).toContain(`'\\''`);
    });
  });

  describe("close", () => {
    it("destroys the underlying sandbox", async () => {
      const fake = fakeSandbox();
      await build(fake).close();
      expect(fake.destroy).toHaveBeenCalled();
    });
  });
});
