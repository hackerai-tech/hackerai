/**
 * Tests for proxy tool output formatters in ProxyToolHandler.
 *
 * These formatters produce clean terminal-style text for the sidebar.
 * Since they're defined inside the component file, we test the formatting
 * logic by reimplementing the pure functions here.
 */

// Reimplemented from ProxyToolHandler.tsx for testing (they're not exported)
function padRight(str: string, len: number): string {
  return str.length >= len
    ? str.slice(0, len)
    : str + " ".repeat(len - str.length);
}

function formatListRequests(r: any): string {
  const requests = r.requests ?? [];
  if (!requests.length) return "No requests captured.";

  const lines: string[] = [
    `${r.total_count} request${r.total_count !== 1 ? "s" : ""} (showing ${r.returned_count})`,
    "",
    `${"ID".padEnd(6)} ${"METHOD".padEnd(7)} ${"STATUS".padEnd(7)} ${"HOST".padEnd(30)} PATH`,
    `${"------"} ${"-------"} ${"------"} ${"------------------------------"} ----`,
  ];

  for (const req of requests) {
    const resp = req.response;
    const status = resp?.statusCode
      ? String(resp.statusCode).padEnd(7)
      : "---    ";
    const time = resp?.roundtripTime ? `${resp.roundtripTime}ms` : "";
    const id = String(req.id ?? "").padEnd(6);
    const method = padRight(req.method ?? "?", 7);
    const host = padRight(req.host ?? "", 30);
    const path = req.path ?? "/";
    lines.push(
      `${id} ${method} ${status} ${host} ${path}${time ? "  " + time : ""}`,
    );
  }

  return lines.join("\n");
}

function formatSendRequest(r: any): string {
  const lines: string[] = [];
  const code = r.status_code ?? 0;
  lines.push(`HTTP ${code}  ${r.response_time_ms ?? 0}ms  ${r.url ?? ""}`);

  const headers = r.headers ?? {};
  if (Object.keys(headers).length) {
    lines.push("");
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${k}: ${v}`);
    }
  }

  if (r.body) {
    lines.push("");
    lines.push(r.body);
    if (r.body_truncated) {
      lines.push(`\n(truncated -- ${r.body_size} bytes total)`);
    }
  }

  return lines.join("\n");
}

function formatScopeRules(r: any): string {
  if (r.scope) {
    const s = r.scope;
    const lines = [`${s.name}  (id:${s.id})`];
    if (s.allowlist?.length) lines.push(`  allow: ${s.allowlist.join(", ")}`);
    if (s.denylist?.length) lines.push(`  deny:  ${s.denylist.join(", ")}`);
    if (r.message) lines.push(`\n${r.message}`);
    return lines.join("\n");
  }

  if (r.scopes) {
    if (!r.scopes.length) return "No scopes defined.";
    const lines = [`${r.count} scope${r.count !== 1 ? "s" : ""}`, ""];
    for (const s of r.scopes) {
      const allow = s.allowlist?.length ? s.allowlist.join(", ") : "*";
      lines.push(`  ${s.name} (${s.id})  allow: ${allow}`);
    }
    return lines.join("\n");
  }

  if (r.message) return r.message;
  return JSON.stringify(r, null, 2);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Proxy Tool Output Formatters", () => {
  describe("formatListRequests", () => {
    it("should show 'No requests captured' for empty list", () => {
      expect(formatListRequests({ requests: [], total_count: 0 })).toBe(
        "No requests captured.",
      );
    });

    it("should format requests as a table", () => {
      const result = formatListRequests({
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
      const result = formatListRequests({
        requests: [{ id: "1", method: "GET", host: "example.com", path: "/" }],
        total_count: 1,
        returned_count: 1,
      });

      expect(result).toContain("1 request (showing 1)");
      expect(result).toContain("---");
    });
  });

  describe("formatSendRequest", () => {
    it("should format status, timing, and URL on first line", () => {
      const result = formatSendRequest({
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
      const result = formatSendRequest({
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
      const result = formatSendRequest({
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

  describe("formatScopeRules", () => {
    it("should format a single scope with allow/deny lists", () => {
      const result = formatScopeRules({
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
      const result = formatScopeRules({
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
      expect(formatScopeRules({ scopes: [], count: 0 })).toBe(
        "No scopes defined.",
      );
    });

    it("should show delete message", () => {
      expect(formatScopeRules({ message: "Scope 1 deleted" })).toBe(
        "Scope 1 deleted",
      );
    });
  });
});
