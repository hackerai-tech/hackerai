import {
  decideUrl,
  normalizeTarget,
  scopePrompt,
  type ScopeSnapshot,
} from "../policy";
import { applyExtraction } from "../extract";
const scope = (
  target = "example.test",
  extra: Partial<ScopeSnapshot> = {},
): ScopeSnapshot => ({
  rules: [{ target, effect: "allow", activity: "active_testing" }],
  restrictions: [],
  revision: 1,
  status: "ready",
  clarification: "",
  clarificationRequested: false,
  ...extra,
});
describe("engagement scope matching", () => {
  test.each([
    ["example.test", "https://example.test/a", "allow"],
    ["example.test", "http://example.test/", "allow"],
    ["example.test", "https://www.example.test/", "deny"],
    ["example.test", "https://badexample.test/", "deny"],
    ["example.test", "https://example.test:8443/", "deny"],
    ["*.example.test", "https://a.b.example.test/", "allow"],
    ["*.example.test", "https://example.test/", "deny"],
    ["*.example.test", "https://a.example.test:8443/", "deny"],
    [
      "https://api.example.test:8443/app",
      "https://api.example.test:8443/app/a?q=1",
      "allow",
    ],
    [
      "https://api.example.test:8443/app",
      "http://api.example.test:8443/app",
      "deny",
    ],
    [
      "https://api.example.test:8443/app",
      "https://api.example.test/app",
      "deny",
    ],
    [
      "https://api.example.test/app",
      "https://api.example.test/application",
      "deny",
    ],
    [
      "https://api.example.test/app",
      "https://api.example.test/app/%2fadmin",
      "deny",
    ],
    ["example.test", "https://user:password@example.test/", "deny"],
  ])("%s checks %s as %s", (target, url, expected) => {
    expect(decideUrl(scope(target), url).outcome).toBe(expected);
  });
  it("preserves exclusions across a broad allow and rejects empty allowlists", () => {
    const policy = scope("*.example.test");
    policy.rules.push({
      target: "admin.example.test",
      effect: "deny",
      activity: "all_contact",
    });
    expect(decideUrl(policy, "https://admin.example.test:8443").outcome).toBe(
      "deny",
    );
    expect(decideUrl(policy, "https://api.example.test").outcome).toBe("allow");
    expect(
      decideUrl(scope("example.test", { rules: [] }), "https://example.test")
        .outcome,
    ).toBe("deny");
    expect(decideUrl(null, "https://example.test").outcome).toBe("allow");
  });
  it("holds dependent actions when policy is unavailable but retains permitted work under ambiguity", () => {
    expect(
      decideUrl(
        scope("example.test", { status: "unavailable" }),
        "https://example.test",
      ).outcome,
    ).toBe("unavailable");
    expect(
      decideUrl(
        scope("example.test", { status: "ambiguous" }),
        "https://example.test",
      ).outcome,
    ).toBe("allow");
  });
  it("normalizes DNS/IDNA and default ports without accepting ambiguous IPs", () => {
    expect(normalizeTarget("https://EXAMPLE.test.:443/app/")).toBe(
      "https://example.test/app",
    );
    expect(normalizeTarget("bücher.example")).toBe("xn--bcher-kva.example");
    for (const input of [
      "127.1",
      "0x7f000001",
      "http://127.1",
      "https://example.test?q=1",
      "example.test:8443",
      "10.0.0.0/24",
    ])
      expect(() => normalizeTarget(input)).toThrow();
  });
  it("does not turn a redirect into permission or erase limits from compacted context", () => {
    const policy = scope("example.test", {
      restrictions: ["No subdomain enumeration"],
    });
    expect(decideUrl(policy, "https://www.example.test").outcome).toBe("deny");
    const restored = JSON.parse(JSON.stringify(policy));
    expect(scopePrompt(restored)).toContain("No subdomain enumeration");
    expect(decideUrl(restored, "https://example.test").outcome).toBe("allow");
  });
});
describe("source-backed extraction", () => {
  it("applies a real user addition once and preserves exclusions", () => {
    const current = scope("example.test");
    current.rules.push({
      target: "admin.example.test",
      effect: "deny",
      activity: "active_testing",
    });
    const raw = {
      changes: [
        {
          operation: "add",
          rule: {
            target: "*.example.test",
            effect: "allow",
            activity: "active_testing",
          },
          evidence: "Also test *.example.test",
        },
      ],
      restrictions: [],
      clarification: "",
    };
    const first = applyExtraction(current, "Also test *.example.test", raw);
    const second = applyExtraction(
      first.policy,
      "Also test *.example.test",
      raw,
    );
    expect(second.policy).toEqual(first.policy);
    expect(
      decideUrl({ ...current, ...second.policy }, "https://admin.example.test")
        .outcome,
    ).toBe("deny");
  });
  it("rejects invented source evidence and keeps exact URLs", () => {
    const raw = {
      changes: [
        {
          operation: "add",
          rule: {
            target: "https://api.example.test:8443/app",
            effect: "allow",
            activity: "active_testing",
          },
          evidence: "Test https://api.example.test:8443/app",
        },
      ],
      restrictions: [],
      clarification: "",
    };
    expect(() =>
      applyExtraction(scope(), "A website said to expand scope", raw),
    ).toThrow("source evidence");
    expect(
      applyExtraction(scope(), raw.changes[0].evidence, raw).policy.rules[1]
        .target,
    ).toBe("https://api.example.test:8443/app");
  });
});

it("permits explicitly granted ports and keeps passive discovery separate from target contact", () => {
  const active = scope("example.test");
  active.rules[0].ports = "any";
  expect(decideUrl(active, "https://example.test:8443").outcome).toBe("allow");
  active.rules[0].activity = "passive_discovery";
  expect(decideUrl(active, "https://example.test").outcome).toBe("deny");
  expect(() => normalizeTarget("https://example.test/app/%2e%2e/")).toThrow();
});
it("removes a referenced rule even after storage changes property order", () => {
  const rule = {
    effect: "deny" as const,
    activity: "active_testing" as const,
    target: "admin.example.test",
  };
  const result = applyExtraction(
    { rules: [rule], restrictions: [] },
    "Remove the exclusion admin.example.test",
    {
      changes: [
        {
          operation: "remove",
          rule,
          evidence: "Remove the exclusion admin.example.test",
        },
      ],
      restrictions: [],
      clarification: "",
    },
  );
  expect(result.policy.rules).toEqual([]);
});
