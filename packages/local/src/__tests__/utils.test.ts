/**
 * Tests for local sandbox utility functions.
 *
 * These tests verify:
 * - Output truncation (25% head + 75% tail strategy)
 * - Docker capabilities for penetration testing tools
 * - Docker run command building
 * - Sandbox mode detection
 * - Shell detection parsing
 */

import {
  truncateOutput,
  TRUNCATION_MARKER,
  MAX_OUTPUT_SIZE,
  DOCKER_CAPABILITIES,
  buildDockerCapabilityFlags,
  buildDockerRunCommand,
  getSandboxMode,
  parseShellDetectionOutput,
  getDefaultShell,
} from "../utils";

describe("Output Truncation", () => {
  it("should not truncate content under max size", () => {
    const content = "short content";
    const result = truncateOutput(content);
    expect(result).toBe(content);
  });

  it("should truncate content over max size with 25% head + 75% tail", () => {
    // Create content larger than MAX_OUTPUT_SIZE
    const content = "A".repeat(MAX_OUTPUT_SIZE + 1000);
    const result = truncateOutput(content);

    expect(result.length).toBeLessThanOrEqual(MAX_OUTPUT_SIZE);
    expect(result).toContain(TRUNCATION_MARKER);
  });

  it("should preserve head content (25%)", () => {
    const head = "HEAD_CONTENT_";
    const middle = "M".repeat(MAX_OUTPUT_SIZE);
    const tail = "_TAIL_CONTENT";
    const content = head + middle + tail;

    const result = truncateOutput(content);

    expect(result.startsWith(head)).toBe(true);
  });

  it("should preserve tail content (75%)", () => {
    const head = "HEAD_CONTENT_";
    const middle = "M".repeat(MAX_OUTPUT_SIZE);
    const tail = "_TAIL_CONTENT";
    const content = head + middle + tail;

    const result = truncateOutput(content);

    expect(result.endsWith(tail)).toBe(true);
  });

  it("should use custom max size", () => {
    const content = "A".repeat(200);
    const result = truncateOutput(content, 100);

    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain(TRUNCATION_MARKER);
  });
});

describe("Docker Capabilities", () => {
  it("should include NET_RAW for ping, nmap, raw sockets", () => {
    expect(DOCKER_CAPABILITIES).toContain("NET_RAW");
  });

  it("should include NET_ADMIN for network interface tools", () => {
    expect(DOCKER_CAPABILITIES).toContain("NET_ADMIN");
  });

  it("should include SYS_PTRACE for debugging tools", () => {
    expect(DOCKER_CAPABILITIES).toContain("SYS_PTRACE");
  });

  it("should build capability flags correctly", () => {
    const flags = buildDockerCapabilityFlags();

    expect(flags).toBe(
      "--cap-add=NET_RAW --cap-add=NET_ADMIN --cap-add=SYS_PTRACE",
    );
  });
});

describe("Docker Run Command", () => {
  it("should build basic docker run command with capabilities", () => {
    const cmd = buildDockerRunCommand({ image: "hackerai/sandbox:latest" });

    expect(cmd).toContain("docker run -d");
    expect(cmd).toContain("--cap-add=NET_RAW");
    expect(cmd).toContain("--cap-add=NET_ADMIN");
    expect(cmd).toContain("--cap-add=SYS_PTRACE");
    expect(cmd).toContain("--network host");
    expect(cmd).toContain("hackerai/sandbox:latest");
    expect(cmd).toContain("tail -f /dev/null");
  });

  it("should include container name when provided", () => {
    const cmd = buildDockerRunCommand({
      image: "hackerai/sandbox:latest",
      containerName: "my-container",
    });

    expect(cmd).toContain("--name my-container");
  });

  it("should not include container name when not provided", () => {
    const cmd = buildDockerRunCommand({ image: "hackerai/sandbox:latest" });

    expect(cmd).not.toContain("--name");
  });

  it("should exclude capabilities when disabled", () => {
    const cmd = buildDockerRunCommand({
      image: "alpine",
      capabilities: false,
    });

    expect(cmd).not.toContain("--cap-add");
  });
});

describe("Sandbox Mode Detection", () => {
  it("should return 'dangerous' when dangerous flag is set", () => {
    const mode = getSandboxMode({
      dangerous: true,
    });

    expect(mode).toBe("dangerous");
  });

  it("should return 'docker' when dangerous flag is not set", () => {
    const mode = getSandboxMode({
      dangerous: false,
    });

    expect(mode).toBe("docker");
  });

  it("should return 'docker' when dangerous flag is undefined", () => {
    const mode = getSandboxMode({});

    expect(mode).toBe("docker");
  });
});

describe("Shell Detection Parsing", () => {
  it("should return bash when found", () => {
    const shell = parseShellDetectionOutput("/bin/bash");
    expect(shell).toBe("/bin/bash");
  });

  it("should return sh when bash not found", () => {
    const shell = parseShellDetectionOutput("/bin/sh");
    expect(shell).toBe("/bin/sh");
  });

  it("should take first line when multiple results", () => {
    const shell = parseShellDetectionOutput("/bin/bash\n/bin/sh");
    expect(shell).toBe("/bin/bash");
  });

  it("should return /bin/sh for empty output", () => {
    const shell = parseShellDetectionOutput("");
    expect(shell).toBe("/bin/sh");
  });

  it("should return /bin/sh for whitespace-only output", () => {
    const shell = parseShellDetectionOutput("   \n  ");
    expect(shell).toBe("/bin/sh");
  });

  it("should handle Alpine busybox ash path", () => {
    const shell = parseShellDetectionOutput("/bin/ash");
    expect(shell).toBe("/bin/ash");
  });
});

describe("Platform Shell Detection", () => {
  it("should return PowerShell for Windows", () => {
    const result = getDefaultShell("win32");
    expect(result.shell).toBe("powershell.exe");
    expect(result.shellFlag).toBe("-Command");
  });

  it("should return bash for Linux", () => {
    const result = getDefaultShell("linux");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });

  it("should return bash for macOS (darwin)", () => {
    const result = getDefaultShell("darwin");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });

  it("should return bash for unknown platforms", () => {
    const result = getDefaultShell("freebsd");
    expect(result.shell).toBe("/bin/bash");
    expect(result.shellFlag).toBe("-c");
  });
});
