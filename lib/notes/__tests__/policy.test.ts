import { describe, expect, it } from "@jest/globals";
import { safeCountTokens } from "@/lib/token-utils";
import {
  extractTaskTargets,
  fitTextToTokens,
  getRecheckState,
  normalizeNoteTarget,
  parseObservedAt,
  taskMentionsLabel,
} from "../policy";

describe("normalizeNoteTarget", () => {
  it.each([
    ["Alpha.Example.", "alpha.example"],
    ["alpha.example:8443", "alpha.example:8443"],
    ["alpha.example:80", "alpha.example:80"],
    ["HTTPS://Alpha.Example:443/", "https://alpha.example"],
    ["http://10.0.0.5:8080", "http://10.0.0.5:8080"],
    ["[::1]:8080", "[::1]:8080"],
    ["label:  Acme   Q4 ", "label:acme q4"],
  ])("normalizes %s deterministically", (raw, expected) => {
    expect(normalizeNoteTarget(raw)).toEqual({ ok: true, target: expected });
  });

  it.each([
    "*.alpha.example",
    "alpha.example/api",
    "https://alpha.example/api/v2",
    "https://user:secret@alpha.example",
    "user@alpha.example",
    "ftp://alpha.example",
    "alpha.example:99999",
    "label:",
    "label:<script>",
  ])("rejects %s instead of broadening or storing it", (raw) => {
    expect(normalizeNoteTarget(raw).ok).toBe(false);
  });
});

describe("extractTaskTargets", () => {
  it("matches a mentioned host and its origins but never its parent domain", () => {
    const keys = extractTaskTargets("Retest api.alpha.example:8443 tomorrow");
    expect(keys).toEqual(
      expect.arrayContaining([
        "api.alpha.example",
        "api.alpha.example:8443",
        "https://api.alpha.example:8443",
      ]),
    );
    expect(keys).not.toContain("alpha.example");
  });

  it("keeps a URL's exact origin without adding the other scheme", () => {
    const keys = extractTaskTargets("see https://alpha.example/login?next=/");
    expect(keys).toContain("https://alpha.example");
    expect(keys).toContain("alpha.example");
    expect(keys).not.toContain("http://alpha.example");
  });

  it("ignores credentials embedded in URLs", () => {
    expect(extractTaskTargets("https://admin:pw@alpha.example/")).toEqual([]);
  });
});

it("matches labels only as whole phrases from the user's task", () => {
  expect(
    taskMentionsLabel("Continue the ACME Q4 engagement", "label:acme q4"),
  ).toBe(true);
  expect(taskMentionsLabel("acme q40 notes", "label:acme q4")).toBe(false);
});

describe("observation and recheck state", () => {
  const now = Date.UTC(2026, 10, 13);

  it("rejects future observations and accepts real dates", () => {
    expect(parseObservedAt("2026-11-14", now).ok).toBe(false);
    expect(parseObservedAt("2026-11-03", now)).toEqual({
      ok: true,
      value: Date.UTC(2026, 10, 3),
    });
  });

  it.each([
    [{ category: "findings", target: "a.example" }, "observation_date_unknown"],
    [
      {
        category: "findings",
        target: "a.example",
        observed_at: now - 1,
        recheck_after: now,
      },
      "recheck_due",
    ],
    [
      {
        category: "findings",
        target: "a.example",
        observed_at: now - 1,
        recheck_after: now + 1,
      },
      undefined,
    ],
    [{ category: "findings", observed_at: now - 1 }, undefined],
    // Untargeted general notes are preferences, not observations.
    [{ category: "general" }, undefined],
  ])("%j -> %s", (note, expected) => {
    expect(getRecheckState(note, now)).toBe(expected);
  });
});

describe("fitTextToTokens", () => {
  it("caps exact tokens without splitting surrogate pairs", () => {
    const text = "🔐漏洞".repeat(500);
    const fitted = fitTextToTokens(text, 100, safeCountTokens);
    expect(fitted.truncated).toBe(true);
    expect(safeCountTokens(fitted.text)).toBeLessThanOrEqual(100);
    expect(fitted.text).toBe(text.slice(0, fitted.consumed));
    expect(fitted.text).not.toMatch(/[\uD800-\uDBFF]$/);
    // Within one code point of the budget, so pages are not needlessly small.
    expect(safeCountTokens(text.slice(0, fitted.consumed + 3))).toBeGreaterThan(
      100,
    );
  });
});
