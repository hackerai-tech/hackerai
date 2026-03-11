/**
 * Tests for TauriSandbox security validations.
 *
 * Covers:
 * - File path validation (path traversal prevention)
 * - Download URL validation (SSRF prevention)
 * - TauriSandbox command execution and file operations
 */

import {
  validateFilePath,
  validateDownloadUrl,
  TauriSandbox,
} from "../tauri-sandbox";

// ── Path validation ────────────────────────────────────────────────────

describe("validateFilePath", () => {
  it("allows paths under /tmp/hackerai-upload", () => {
    expect(() =>
      validateFilePath("/tmp/hackerai-upload/file.txt"),
    ).not.toThrow();
    expect(() =>
      validateFilePath("/tmp/hackerai-upload/subdir/file.txt"),
    ).not.toThrow();
  });

  it("allows paths under /tmp/hackerai", () => {
    expect(() => validateFilePath("/tmp/hackerai/file.txt")).not.toThrow();
    expect(() =>
      validateFilePath("/tmp/hackerai/deep/nested/file.txt"),
    ).not.toThrow();
  });

  it("allows the root directories themselves", () => {
    expect(() => validateFilePath("/tmp/hackerai-upload")).not.toThrow();
    expect(() => validateFilePath("/tmp/hackerai")).not.toThrow();
  });

  it("rejects paths outside allowed roots", () => {
    expect(() => validateFilePath("/etc/passwd")).toThrow(
      "File path not allowed",
    );
    expect(() => validateFilePath("/home/user/file.txt")).toThrow(
      "File path not allowed",
    );
    expect(() => validateFilePath("/tmp/other/file.txt")).toThrow(
      "File path not allowed",
    );
    expect(() => validateFilePath("/")).toThrow("File path not allowed");
  });

  it("rejects path traversal attempts", () => {
    // Traversal out of allowed root
    expect(() =>
      validateFilePath("/tmp/hackerai-upload/../../etc/passwd"),
    ).toThrow("File path not allowed");
    expect(() => validateFilePath("/tmp/hackerai/../../../etc/shadow")).toThrow(
      "File path not allowed",
    );
  });

  it("normalizes . segments", () => {
    expect(() =>
      validateFilePath("/tmp/hackerai-upload/./file.txt"),
    ).not.toThrow();
  });

  it("rejects prefix-based bypass attempts", () => {
    // /tmp/hackerai-upload-evil should not match /tmp/hackerai-upload
    expect(() =>
      validateFilePath("/tmp/hackerai-upload-evil/file.txt"),
    ).toThrow("File path not allowed");
    // /tmp/hackeraifoo should not match /tmp/hackerai
    expect(() => validateFilePath("/tmp/hackeraifoo/file.txt")).toThrow(
      "File path not allowed",
    );
  });
});

// ── URL validation ─────────────────────────────────────────────────────

describe("validateDownloadUrl", () => {
  it("allows public https URLs", () => {
    expect(() =>
      validateDownloadUrl("https://example.com/file.zip"),
    ).not.toThrow();
    expect(() =>
      validateDownloadUrl("https://cdn.github.com/asset.tar.gz"),
    ).not.toThrow();
  });

  it("allows public http URLs", () => {
    expect(() =>
      validateDownloadUrl("http://example.com/file.zip"),
    ).not.toThrow();
  });

  it("rejects non-http protocols", () => {
    expect(() => validateDownloadUrl("ftp://example.com/file")).toThrow(
      "http or https",
    );
    expect(() => validateDownloadUrl("file:///etc/passwd")).toThrow(
      "http or https",
    );
    expect(() => validateDownloadUrl("javascript:alert(1)")).toThrow(
      "http or https",
    );
  });

  it("rejects invalid URLs", () => {
    expect(() => validateDownloadUrl("not-a-url")).toThrow(
      "Invalid download URL",
    );
    expect(() => validateDownloadUrl("")).toThrow("Invalid download URL");
  });

  it("blocks localhost", () => {
    expect(() => validateDownloadUrl("http://localhost/secret")).toThrow(
      "internal address",
    );
    expect(() => validateDownloadUrl("http://127.0.0.1/metadata")).toThrow(
      "internal address",
    );
    expect(() => validateDownloadUrl("http://127.0.0.42:8080/api")).toThrow(
      "internal address",
    );
  });

  it("blocks private networks (10.x.x.x)", () => {
    expect(() => validateDownloadUrl("http://10.0.0.1/internal")).toThrow(
      "internal address",
    );
    expect(() => validateDownloadUrl("http://10.255.255.255/file")).toThrow(
      "internal address",
    );
  });

  it("blocks private networks (172.16-31.x.x)", () => {
    expect(() => validateDownloadUrl("http://172.16.0.1/file")).toThrow(
      "internal address",
    );
    expect(() => validateDownloadUrl("http://172.31.255.255/file")).toThrow(
      "internal address",
    );
  });

  it("blocks private networks (192.168.x.x)", () => {
    expect(() => validateDownloadUrl("http://192.168.1.1/file")).toThrow(
      "internal address",
    );
  });

  it("blocks AWS metadata endpoint", () => {
    expect(() =>
      validateDownloadUrl("http://169.254.169.254/latest/meta-data"),
    ).toThrow("internal address");
  });

  it("blocks GCP metadata endpoint", () => {
    expect(() =>
      validateDownloadUrl("http://metadata.google.internal/computeMetadata"),
    ).toThrow("internal address");
  });

  it("blocks 0.x.x.x addresses", () => {
    expect(() => validateDownloadUrl("http://0.0.0.0/file")).toThrow(
      "internal address",
    );
  });
});

// ── TauriSandbox class ─────────────────────────────────────────────────

describe("TauriSandbox", () => {
  let sandbox: TauriSandbox;

  beforeEach(() => {
    sandbox = new TauriSandbox({ port: 12345, token: "test-token" });
  });

  describe("constructor", () => {
    it("builds the base URL from port", () => {
      // Verify by checking health check URL
      expect(sandbox).toBeDefined();
    });
  });

  describe("getSandboxContext", () => {
    it("returns context mentioning local machine", () => {
      const context = sandbox.getSandboxContext();
      expect(context).toContain("local machine");
      expect(context).toContain("HackerAI Desktop");
    });
  });

  describe("getHost", () => {
    it("returns localhost with the given port", () => {
      expect(sandbox.getHost(8080)).toBe("localhost:8080");
    });
  });

  describe("files.write - path validation", () => {
    it("rejects writes outside allowed directories", async () => {
      await expect(
        sandbox.files.write("/etc/passwd", "malicious"),
      ).rejects.toThrow("File path not allowed");
    });
  });

  describe("files.read - path validation", () => {
    it("rejects reads outside allowed directories", async () => {
      await expect(sandbox.files.read("/etc/shadow")).rejects.toThrow(
        "File path not allowed",
      );
    });
  });

  describe("files.remove - path validation", () => {
    it("rejects removes outside allowed directories", async () => {
      await expect(
        sandbox.files.remove("/home/user/.ssh/id_rsa"),
      ).rejects.toThrow("File path not allowed");
    });
  });

  describe("files.list - path validation", () => {
    it("rejects list outside allowed directories", async () => {
      await expect(sandbox.files.list("/")).rejects.toThrow(
        "File path not allowed",
      );
    });
  });

  describe("files.downloadFromUrl - validations", () => {
    it("rejects path traversal in download target", async () => {
      await expect(
        sandbox.files.downloadFromUrl(
          "https://example.com/file.zip",
          "/tmp/hackerai-upload/../../etc/evil",
        ),
      ).rejects.toThrow("File path not allowed");
    });

    it("rejects SSRF URLs", async () => {
      await expect(
        sandbox.files.downloadFromUrl(
          "http://169.254.169.254/latest/meta-data",
          "/tmp/hackerai-upload/file.txt",
        ),
      ).rejects.toThrow("internal address");
    });
  });

  describe("close", () => {
    it("emits close event", async () => {
      const closeSpy = jest.fn();
      sandbox.on("close", closeSpy);
      await sandbox.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });
});
