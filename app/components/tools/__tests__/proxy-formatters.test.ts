/**
 * Tests for proxy tool output formatters.
 * Imports the real formatProxyOutput from ProxyToolHandler.
 */

import { formatProxyOutput } from "../ProxyToolHandler";

describe("Proxy Tool Output Formatters", () => {
  describe("list_requests", () => {
    it("should show 'No requests captured' for empty list", () => {
      expect(
        formatProxyOutput("list_requests", { requests: [], total_count: 0 }),
      ).toBe("No requests captured.");
    });

    it("should format requests as a table", () => {
      const result = formatProxyOutput("list_requests", {
        requests: [
          {
            id: "1",
            method: "GET",
            host: "example.com",
            path: "/api/users",
            response: { statusCode: 200, roundtripTime: 150 },
          },
          {
            id: "2",
            method: "POST",
            host: "example.com",
            path: "/api/login",
            response: { statusCode: 401, roundtripTime: 50 },
          },
        ],
        total_count: 2,
        returned_count: 2,
      });

      expect(result).toContain("2 requests (showing 2)");
      expect(result).toContain("GET");
      expect(result).toContain("POST");
      expect(result).toContain("example.com");
      expect(result).toContain("/api/users");
      expect(result).toContain("/api/login");
      expect(result).toContain("200");
      expect(result).toContain("401");
      expect(result).toContain("150ms");
      expect(result).toContain("50ms");
    });

    it("should handle requests without responses", () => {
      const result = formatProxyOutput("list_requests", {
        requests: [{ id: "1", method: "GET", host: "example.com", path: "/" }],
        total_count: 1,
        returned_count: 1,
      });

      expect(result).toContain("1 request (showing 1)");
      expect(result).toContain("---");
    });
  });

  describe("send_request", () => {
    it("should format status, timing, and URL on first line", () => {
      const result = formatProxyOutput("send_request", {
        status_code: 200,
        response_time_ms: 150,
        url: "https://example.com/api",
        headers: {},
        body: '{"ok": true}',
      });

      expect(result).toContain("HTTP 200  150ms  https://example.com/api");
      expect(result).toContain('{"ok": true}');
    });

    it("should show filtered headers", () => {
      const result = formatProxyOutput("send_request", {
        status_code: 200,
        response_time_ms: 50,
        url: "https://example.com",
        headers: {
          "content-type": "application/json",
          server: "nginx",
        },
        body: "{}",
      });

      expect(result).toContain("content-type: application/json");
      expect(result).toContain("server: nginx");
    });

    it("should show truncation notice", () => {
      const result = formatProxyOutput("send_request", {
        status_code: 200,
        response_time_ms: 50,
        url: "https://example.com",
        headers: {},
        body: "large body...",
        body_truncated: true,
        body_size: 50000,
      });

      expect(result).toContain("truncated -- 50000 bytes total");
    });
  });

  describe("scope_rules", () => {
    it("should format a single scope with allow/deny lists", () => {
      const result = formatProxyOutput("scope_rules", {
        scope: {
          id: "1",
          name: "pentest-target",
          allowlist: ["*.example.com"],
          denylist: ["*.css", "*.js"],
        },
      });

      expect(result).toContain("pentest-target  (id:1)");
      expect(result).toContain("allow: *.example.com");
      expect(result).toContain("deny:  *.css, *.js");
    });

    it("should format scope list", () => {
      const result = formatProxyOutput("scope_rules", {
        scopes: [
          { id: "1", name: "scope-a", allowlist: ["*.a.com"] },
          { id: "2", name: "scope-b", allowlist: [] },
        ],
        count: 2,
      });

      expect(result).toContain("2 scopes");
      expect(result).toContain("scope-a (1)  allow: *.a.com");
      expect(result).toContain("scope-b (2)  allow: *");
    });

    it("should show 'No scopes defined' for empty list", () => {
      expect(formatProxyOutput("scope_rules", { scopes: [], count: 0 })).toBe(
        "No scopes defined.",
      );
    });

    it("should show delete message", () => {
      expect(
        formatProxyOutput("scope_rules", { message: "Scope 1 deleted" }),
      ).toBe("Scope 1 deleted");
    });
  });

  describe("view_request", () => {
    it("should show paginated content", () => {
      const result = formatProxyOutput("view_request", {
        id: "1",
        content: "GET /api HTTP/1.1\nHost: example.com",
        page: 1,
        total_pages: 1,
        has_more: false,
      });

      expect(result).toContain("GET /api HTTP/1.1");
      expect(result).toContain("Host: example.com");
    });

    it("should show pagination header when has_more", () => {
      const result = formatProxyOutput("view_request", {
        id: "1",
        content: "line1\nline2",
        page: 1,
        total_pages: 3,
        showing_lines: "1-50 of 150",
        has_more: true,
      });

      expect(result).toContain("[Lines 1-50 of 150, page 1/3]");
    });

    it("should show search matches", () => {
      const result = formatProxyOutput("view_request", {
        id: "1",
        matches: [{ match: "password", before: "name=", after: "&submit=1" }],
        total_matches: 1,
        search_pattern: "password",
      });

      expect(result).toContain('1 match for "password"');
      expect(result).toContain(">>>password<<<");
    });
  });

  describe("list_sitemap", () => {
    it("should show 'No sitemap entries' for empty list", () => {
      expect(
        formatProxyOutput("list_sitemap", { entries: [], total_count: 0 }),
      ).toBe("No sitemap entries.");
    });

    it("should format entries with kind indicators", () => {
      const result = formatProxyOutput("list_sitemap", {
        entries: [
          {
            id: "1",
            kind: "DOMAIN",
            label: "example.com",
            hasDescendants: true,
            metadata: { isTls: true, port: 443 },
          },
          {
            id: "2",
            kind: "REQUEST",
            label: "/api/users",
            hasDescendants: false,
            request: { method: "GET", status: 200 },
          },
        ],
        total_count: 2,
        showing: "1-2 of 2",
      });

      expect(result).toContain("[D]");
      expect(result).toContain("example.com");
      expect(result).toContain("(https:443)");
      expect(result).toContain("GET");
      expect(result).toContain("/api/users");
    });
  });

  describe("unknown tool", () => {
    it("should fallback to JSON.stringify", () => {
      const result = formatProxyOutput("unknown_tool", { foo: "bar" });
      expect(result).toBe(JSON.stringify({ foo: "bar" }, null, 2));
    });
  });
});
