import {
  escapeSingleQuotes,
  parseScope,
  formatRgError,
  classifyExecutionError,
} from "../match";

describe("match tool helpers", () => {
  describe("escapeSingleQuotes", () => {
    it("returns strings without quotes unchanged", () => {
      expect(escapeSingleQuotes("hello")).toBe("hello");
    });

    it("escapes a single quote", () => {
      expect(escapeSingleQuotes("it's")).toBe("it'\\''s");
    });

    it("escapes multiple single quotes", () => {
      expect(escapeSingleQuotes("a'b'c")).toBe("a'\\''b'\\''c");
    });

    it("handles empty string", () => {
      expect(escapeSingleQuotes("")).toBe("");
    });

    it("does not escape double quotes", () => {
      expect(escapeSingleQuotes('say "hi"')).toBe('say "hi"');
    });
  });

  describe("parseScope", () => {
    it("splits an absolute path with a glob suffix", () => {
      expect(parseScope("/home/user/**/*.py")).toEqual({
        baseDir: "/home/user",
        globPattern: "**/*.py",
      });
    });

    it("returns ** as globPattern when scope ends with **", () => {
      expect(parseScope("/home/user/src/**")).toEqual({
        baseDir: "/home/user/src",
        globPattern: "**",
      });
    });

    it("handles a bare glob pattern with no leading path", () => {
      expect(parseScope("**/*.ts")).toEqual({
        baseDir: ".",
        globPattern: "**/*.ts",
      });
    });

    it("handles a plain directory with no globs", () => {
      expect(parseScope("/home/user/project")).toEqual({
        baseDir: "/home/user/project",
        globPattern: null,
      });
    });

    it("handles a single wildcard in the filename", () => {
      expect(parseScope("/home/user/*.js")).toEqual({
        baseDir: "/home/user",
        globPattern: "*.js",
      });
    });

    it("handles question-mark wildcards", () => {
      expect(parseScope("/data/file?.txt")).toEqual({
        baseDir: "/data",
        globPattern: "file?.txt",
      });
    });

    it("handles bracket patterns", () => {
      expect(parseScope("/src/[abc]/*.ts")).toEqual({
        baseDir: "/src",
        globPattern: "[abc]/*.ts",
      });
    });

    it("handles brace patterns", () => {
      expect(parseScope("/src/{a,b}/*.ts")).toEqual({
        baseDir: "/src",
        globPattern: "{a,b}/*.ts",
      });
    });

    it("handles deeply nested glob in the middle", () => {
      expect(parseScope("/home/user/project/src/**/*.test.ts")).toEqual({
        baseDir: "/home/user/project/src",
        globPattern: "**/*.test.ts",
      });
    });

    it("handles root path with glob", () => {
      expect(parseScope("/**/*.py")).toEqual({
        baseDir: ".",
        globPattern: "**/*.py",
      });
    });

    it("handles dot directory", () => {
      expect(parseScope(".")).toEqual({
        baseDir: ".",
        globPattern: null,
      });
    });
  });

  describe("formatRgError", () => {
    it("detects regex parse errors", () => {
      const stderr = "regex parse error:\n  [unclosed";
      const result = formatRgError(stderr, "grep", "/home/**");
      expect(result).toContain("Invalid regex pattern");
      expect(result).toContain("regex parse error");
    });

    it("detects invalid glob patterns", () => {
      const stderr = "invalid glob: unclosed bracket";
      const result = formatRgError(stderr, "glob", "/home/[*.ts");
      expect(result).toContain("Invalid glob pattern");
      expect(result).toContain("/home/[*.ts");
    });

    it("detects permission denied", () => {
      const stderr = "Permission denied (os error 13)";
      const result = formatRgError(stderr, "grep", "/root/**");
      expect(result).toContain("Permission denied");
    });

    it("detects no such file or directory", () => {
      const stderr = "/nonexistent: No such file or directory";
      const result = formatRgError(stderr, "glob", "/nonexistent/**");
      expect(result).toContain("does not exist");
    });

    it("returns a generic message for unknown errors", () => {
      const stderr = "something unexpected went wrong";
      const result = formatRgError(stderr, "grep", "/src/**");
      expect(result).toContain("grep failed");
      expect(result).toContain("something unexpected went wrong");
    });

    it("handles empty stderr gracefully", () => {
      const result = formatRgError("", "glob", "/src/**");
      expect(result).toContain("glob failed");
      expect(result).toContain("unknown error");
    });
  });

  describe("classifyExecutionError", () => {
    it("classifies timeout errors", () => {
      const result = classifyExecutionError(new Error("Command timed out"));
      expect(result).toContain("timed out");
    });

    it("classifies sandbox-not-ready errors", () => {
      const result = classifyExecutionError(new Error("sandbox not ready yet"));
      expect(result).toContain("Sandbox environment is not available");
    });

    it("classifies network connection errors", () => {
      const cases = ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"];
      for (const errCode of cases) {
        const result = classifyExecutionError(new Error(errCode));
        expect(result).toContain("Network error");
      }
    });

    it("classifies disk-full errors", () => {
      const result = classifyExecutionError(
        new Error("ENOSPC: no space left on device"),
      );
      expect(result).toContain("disk is full");
    });

    it("falls back to generic message for unknown errors", () => {
      const result = classifyExecutionError(new Error("bizarre failure"));
      expect(result).toContain("Search failed unexpectedly");
      expect(result).toContain("bizarre failure");
    });

    it("handles non-Error values", () => {
      const result = classifyExecutionError("string error");
      expect(result).toContain("Search failed unexpectedly");
      expect(result).toContain("string error");
    });

    it("handles null/undefined", () => {
      const result = classifyExecutionError(null);
      expect(result).toContain("Search failed unexpectedly");
    });
  });
});
