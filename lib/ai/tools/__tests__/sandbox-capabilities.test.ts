/**
 * Tests for sandbox capabilities required for penetration testing tools.
 *
 * Background:
 * - Network tools (ping, nmap, etc.) require raw socket access
 * - E2B sandbox: runs as 'user' by default, needs user: "root" option
 * - Docker sandbox: needs --cap-add flags (NET_RAW, NET_ADMIN, SYS_PTRACE)
 *
 * See commits:
 * - 6d5d1df: Removed hardcoded user:root (broke E2B network tools)
 * - 713f6ad: Added Docker capabilities
 * - 3fde55c: Restored user:root for E2B only
 */

import {
  buildSandboxCommandOptions,
  MAX_COMMAND_EXECUTION_TIME,
} from "../utils/sandbox-command-options";
import {
  isCloudSandbox,
  isE2BSandbox,
  isMiosaSandbox,
  getSandboxInfoForInstance,
  getSandboxLogFields,
} from "../utils/sandbox-types";

// Mock E2B sandbox (the fallback cloud shape after MIOSA/Centrifugo checks).
const createMockE2BSandbox = () => ({
  jupyterUrl: "http://localhost:8888",
  commands: { run: jest.fn() },
});

// Mock CentrifugoSandbox (no jupyterUrl property)
const createMockCentrifugoSandbox = () => ({
  sandboxKind: "centrifugo" as const,
  commands: { run: jest.fn() },
});

const createMockMiosaSandbox = () => ({
  sandboxKind: "miosa" as const,
  commands: { run: jest.fn() },
});

describe("Sandbox Capabilities for Network Tools", () => {
  describe("buildSandboxCommandOptions", () => {
    it("should include user:root and cwd:/home/user for E2B sandbox", () => {
      const e2bSandbox = createMockE2BSandbox();

      const options = buildSandboxCommandOptions(e2bSandbox as any);

      expect(options).toHaveProperty("user", "root");
      expect(options).toHaveProperty("cwd", "/home/user");
      expect(options.timeoutMs).toBe(MAX_COMMAND_EXECUTION_TIME);
    });

    it("should NOT include user:root for CentrifugoSandbox (uses Docker capabilities)", () => {
      const centrifugoSandbox = createMockCentrifugoSandbox();

      const options = buildSandboxCommandOptions(centrifugoSandbox as any);

      expect(options).not.toHaveProperty("user");
      expect(options).not.toHaveProperty("cwd");
      expect(options.timeoutMs).toBe(MAX_COMMAND_EXECUTION_TIME);
    });

    it("should include handlers when provided", () => {
      const centrifugoSandbox = createMockCentrifugoSandbox();
      const onStdout = jest.fn();
      const onStderr = jest.fn();

      const options = buildSandboxCommandOptions(centrifugoSandbox as any, {
        onStdout,
        onStderr,
      });

      expect(options.onStdout).toBe(onStdout);
      expect(options.onStderr).toBe(onStderr);
    });
  });

  describe("Sandbox Type Detection", () => {
    it("should distinguish E2B, MIOSA, and Centrifugo sandboxes", () => {
      const e2bSandbox = createMockE2BSandbox();
      const miosaSandbox = createMockMiosaSandbox();
      const centrifugoSandbox = createMockCentrifugoSandbox();

      expect(isE2BSandbox(e2bSandbox as any)).toBe(true);
      expect(isE2BSandbox(miosaSandbox as any)).toBe(false);
      expect(isE2BSandbox(centrifugoSandbox as any)).toBe(false);
      expect(isMiosaSandbox(miosaSandbox as any)).toBe(true);
      expect(isCloudSandbox(e2bSandbox as any)).toBe(true);
      expect(isCloudSandbox(miosaSandbox as any)).toBe(true);
      expect(isCloudSandbox(centrifugoSandbox as any)).toBe(false);
      expect(isE2BSandbox(null)).toBe(false);
    });

    it("separates the cloud environment type from its concrete provider", () => {
      const e2bSandbox = createMockE2BSandbox();
      const miosaSandbox = createMockMiosaSandbox();

      expect(getSandboxInfoForInstance(e2bSandbox as any)).toEqual({
        type: "cloud",
        provider: "e2b",
      });
      expect(getSandboxInfoForInstance(miosaSandbox as any)).toEqual({
        type: "cloud",
        provider: "miosa",
      });
      expect(getSandboxLogFields(miosaSandbox as any)).toEqual({
        sandbox_type: "cloud",
        sandbox_provider: "miosa",
      });
    });

    it("distinguishes desktop from remote local connections", () => {
      const desktop = {
        sandboxKind: "centrifugo" as const,
        getConnectionInfo: () => ({ name: "Laptop", isDesktop: true }),
      };
      const remote = {
        sandboxKind: "centrifugo" as const,
        getConnectionInfo: () => ({ name: "Server", isDesktop: false }),
      };

      expect(getSandboxInfoForInstance(desktop as any)).toEqual({
        type: "desktop",
        name: "Laptop",
      });
      expect(getSandboxInfoForInstance(remote as any)).toEqual({
        type: "remote-connection",
        name: "Server",
      });
    });
  });
});
