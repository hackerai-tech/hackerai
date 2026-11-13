import {
  getPlatformDisplayName,
  escapeShellValue,
  normalizeSandboxPlatform,
} from "../platform-utils";

describe("normalizeSandboxPlatform", () => {
  it.each([
    // Desktop get_desktop_os_info publishes Rust std::env::consts::OS.
    ["windows", "win32"],
    ["macos", "darwin"],
    ["linux", "linux"],
    ["MINGW64_NT-10.0-22631", "win32"],
    ["msys_nt-10.0-22631", "win32"],
    ["win32", "win32"],
    ["darwin", "darwin"],
  ])("maps %s to %s", (reported, expected) => {
    expect(normalizeSandboxPlatform(reported)).toBe(expected);
  });

  it.each(["Windows", "MacOS", "windows_nt", "win", "mac", "freebsd", ""])(
    "does not guess a Node platform from %j",
    (reported) => {
      expect(normalizeSandboxPlatform(reported)).toBe(reported);
    },
  );
});

describe("getPlatformDisplayName", () => {
  it("returns macOS for darwin", () => {
    expect(getPlatformDisplayName("darwin")).toBe("macOS");
  });

  it("returns Windows for win32", () => {
    expect(getPlatformDisplayName("win32")).toBe("Windows");
  });

  it("returns Linux for linux", () => {
    expect(getPlatformDisplayName("linux")).toBe("Linux");
  });

  it("returns the raw string for unknown platforms", () => {
    expect(getPlatformDisplayName("freebsd")).toBe("freebsd");
  });
});

describe("escapeShellValue", () => {
  describe("POSIX (default / linux / darwin)", () => {
    it("wraps a simple string in single quotes", () => {
      expect(escapeShellValue("hello", "linux")).toBe("'hello'");
    });

    it("escapes inner single quotes", () => {
      expect(escapeShellValue("it's", "linux")).toBe("'it'\\''s'");
    });

    it("handles empty string", () => {
      expect(escapeShellValue("", "linux")).toBe("''");
    });

    it("handles strings with spaces", () => {
      expect(escapeShellValue("hello world", "darwin")).toBe("'hello world'");
    });

    it("handles strings with double quotes (no special escaping needed)", () => {
      expect(escapeShellValue('say "hi"', "linux")).toBe("'say \"hi\"'");
    });

    it("handles strings with dollar signs (safe inside single quotes)", () => {
      expect(escapeShellValue("$HOME", "linux")).toBe("'$HOME'");
    });

    it("handles strings with backticks (safe inside single quotes)", () => {
      expect(escapeShellValue("`whoami`", "linux")).toBe("'`whoami`'");
    });

    it("handles strings with newlines", () => {
      expect(escapeShellValue("line1\nline2", "linux")).toBe("'line1\nline2'");
    });

    it("handles multiple single quotes", () => {
      expect(escapeShellValue("it's a 'test'", "linux")).toBe(
        "'it'\\''s a '\\''test'\\'''",
      );
    });
  });

  describe("Windows (win32)", () => {
    it("wraps a simple string in double quotes", () => {
      expect(escapeShellValue("hello", "win32")).toBe('"hello"');
    });

    it("escapes inner double quotes by doubling", () => {
      expect(escapeShellValue('say "hi"', "win32")).toBe('"say ""hi"""');
    });

    it("handles empty string", () => {
      expect(escapeShellValue("", "win32")).toBe('""');
    });

    it("handles strings with spaces", () => {
      expect(escapeShellValue("hello world", "win32")).toBe('"hello world"');
    });

    it("handles strings with single quotes (no escaping needed)", () => {
      expect(escapeShellValue("it's", "win32")).toBe('"it\'s"');
    });
  });

  describe("platform detection fallback", () => {
    it("uses process.platform when no platform override given", () => {
      // Should not throw regardless of current platform
      const result = escapeShellValue("test");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
