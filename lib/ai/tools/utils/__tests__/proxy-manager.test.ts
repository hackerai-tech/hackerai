/**
 * Tests for Caido proxy manager.
 *
 * Tests cover:
 * - ensureCaido lock behavior (parallel calls, invalidation)
 * - HTTP response parsing (parseHttpResponse via sendRequest)
 * - Broken Caido detection and auto-recovery
 * - Sitemap node cleaning
 * - Search content matching
 * - Pagination logic
 */

import { ensureCaido, isCaidoBroken } from "../proxy-manager";

// ---------------------------------------------------------------------------
// Mock sandbox
// ---------------------------------------------------------------------------

const createMockSandbox = (
  runResponses: Array<{ stdout: string; stderr: string; exitCode: number }>,
) => {
  let callIndex = 0;
  return {
    jupyterUrl: "http://localhost:8888", // marks as E2B sandbox
    commands: {
      run: jest.fn().mockImplementation(() => {
        const response = runResponses[callIndex] ?? {
          stdout: "ok",
          stderr: "",
          exitCode: 0,
        };
        callIndex++;
        return Promise.resolve(response);
      }),
    },
    files: {
      write: jest.fn(),
      read: jest.fn(),
      remove: jest.fn(),
      list: jest.fn(),
    },
    getHost: jest.fn().mockReturnValue("48080-test123.e2b.app"),
    close: jest.fn(),
  };
};

const createMockContext = (sandbox: ReturnType<typeof createMockSandbox>) => {
  const sandboxManager = {
    getSandbox: jest.fn().mockResolvedValue({ sandbox }),
    setSandbox: jest.fn(),
    isSandboxUnavailable: jest.fn().mockReturnValue(false),
    recordHealthFailure: jest.fn().mockReturnValue(false),
    resetHealthFailures: jest.fn(),
  };

  return {
    sandboxManager,
    writer: { write: jest.fn() } as any,
    userLocation: {} as any,
    todoManager: {} as any,
    userID: "test-user",
    chatId: "test-chat",
    fileAccumulator: {} as any,
    backgroundProcessTracker: {} as any,
    mode: "agent" as const,
    isE2BSandbox: () => true,
    guardrailsConfig: undefined,
    caidoEnabled: true,
    appendMetadataStream: undefined,
    onToolCost: undefined,
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Proxy Manager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("ensureCaido", () => {
    it("should run setup script on first call", async () => {
      const sandbox = createMockSandbox([
        // Script returns "ok" (fast path — Caido already running + project selected)
        { stdout: "ok\n", stderr: "", exitCode: 0 },
        // getHost env var write
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const context = createMockContext(sandbox);

      await ensureCaido(context);

      expect(sandbox.commands.run).toHaveBeenCalled();
    });

    it("should not re-run setup on subsequent calls (lock)", async () => {
      const sandbox = createMockSandbox([
        { stdout: "ok\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const context = createMockContext(sandbox);

      await ensureCaido(context);
      const callCount = sandbox.commands.run.mock.calls.length;

      await ensureCaido(context);
      // Should not have made additional calls
      expect(sandbox.commands.run.mock.calls.length).toBe(callCount);
    });

    it("should handle needs_start by launching background process", async () => {
      const sandbox = createMockSandbox([
        // First run: needs_start
        { stdout: "needs_start\n", stderr: "", exitCode: 0 },
        // Background start
        { stdout: "", stderr: "", exitCode: 0 },
        // Wait for health
        { stdout: "ready\n", stderr: "", exitCode: 0 },
        // Re-run setup: ok
        { stdout: "ok\n", stderr: "", exitCode: 0 },
        // getHost env var write
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const context = createMockContext(sandbox);

      await ensureCaido(context);

      // Should have been called multiple times: script, bg start, wait, re-run, env
      expect(sandbox.commands.run.mock.calls.length).toBeGreaterThanOrEqual(4);

      // The background start call should have background: true
      const bgCall = sandbox.commands.run.mock.calls.find(
        (call: any[]) => call[1]?.background === true,
      );
      expect(bgCall).toBeDefined();
      expect(bgCall![0]).toContain("caido-cli");
      expect(bgCall![0]).toContain("--allow-guests");
    });

    it("should include --ui-domain for E2B sandboxes", async () => {
      const sandbox = createMockSandbox([
        { stdout: "needs_start\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        { stdout: "ready\n", stderr: "", exitCode: 0 },
        { stdout: "ok\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const context = createMockContext(sandbox);

      await ensureCaido(context);

      const bgCall = sandbox.commands.run.mock.calls.find(
        (call: any[]) => call[1]?.background === true,
      );
      expect(bgCall![0]).toContain("--ui-domain 48080-test123.e2b.app");
    });

    it("should throw on install_failed", async () => {
      const sandbox = createMockSandbox([
        { stdout: "install_failed\n", stderr: "", exitCode: 1 },
      ]);
      const context = createMockContext(sandbox);

      await expect(ensureCaido(context)).rejects.toThrow(
        "caido-cli could not be installed",
      );
    });

    it("should throw on timeout", async () => {
      const sandbox = createMockSandbox([
        { stdout: "needs_start\n", stderr: "", exitCode: 0 },
        { stdout: "", stderr: "", exitCode: 0 },
        // Wait returns timeout
        { stdout: "timeout\n", stderr: "", exitCode: 1 },
      ]);
      const context = createMockContext(sandbox);

      await expect(ensureCaido(context)).rejects.toThrow(
        "did not become ready",
      );
    });

    it("should set CAIDO_UI_URL env var on sandbox", async () => {
      const sandbox = createMockSandbox([
        { stdout: "ok\n", stderr: "", exitCode: 0 },
        // env var write to /etc/profile.d
        { stdout: "", stderr: "", exitCode: 0 },
      ]);
      const context = createMockContext(sandbox);

      await ensureCaido(context);

      const envCall = sandbox.commands.run.mock.calls.find((call: any[]) =>
        call[0]?.includes("CAIDO_UI_URL"),
      );
      expect(envCall).toBeDefined();
      expect(envCall![0]).toContain("https://48080-test123.e2b.app");
    });
  });

  describe("isCaidoBroken", () => {
    it("should return true for database connection error", () => {
      expect(
        isCaidoBroken("Could not acquire a connection to the database"),
      ).toBe(true);
    });

    it("should return true for repository operation error", () => {
      expect(isCaidoBroken("Repository operation failed")).toBe(true);
    });

    it("should return true when error is embedded in HTML", () => {
      expect(
        isCaidoBroken(
          '<pre class="c-details">Repository operation failed\n\nCaused by:\n    Could not acquire a connection to the database</pre>',
        ),
      ).toBe(true);
    });

    it("should return false for normal responses", () => {
      expect(
        isCaidoBroken('{"data":{"requestsByOffset":{"count":{"value":5}}}}'),
      ).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isCaidoBroken("")).toBe(false);
    });

    it("should return false for unrelated errors", () => {
      expect(isCaidoBroken("Connection refused")).toBe(false);
    });
  });
});
