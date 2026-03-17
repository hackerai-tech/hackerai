/**
 * Tests for path validation security utilities.
 *
 * Covers:
 * - Download URL validation (SSRF prevention)
 */

import { validateDownloadUrl } from "../path-validation";

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
