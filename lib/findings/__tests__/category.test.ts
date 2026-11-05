import { deriveFindingCategory, FINDING_CATEGORY_LABELS } from "../category";

describe("finding categories", () => {
  it.each([
    ["CWE-639", "Unrelated title", "access_control"],
    ["CWE-89", "Unrelated title", "injection"],
    ["CWE-79", "Unrelated title", "cross_site_scripting"],
    ["CWE-918", "Unrelated title", "request_forgery"],
    ["CWE-22", "Unrelated title", "file_path_access"],
  ] as const)("maps %s to %s", (cwe, title, expected) => {
    expect(deriveFindingCategory({ cwe, title })).toBe(expected);
  });

  it("uses the title when CWE is absent or unknown", () => {
    expect(
      deriveFindingCategory({ title: "Confirmed SQL injection in search" }),
    ).toBe("injection");
    expect(
      deriveFindingCategory({
        cwe: "CWE-9999",
        title: "Cross-tenant IDOR exposes invoices",
      }),
    ).toBe("access_control");
  });

  it("falls back to a stable user-facing category", () => {
    const category = deriveFindingCategory({ title: "Unexpected weakness" });
    expect(category).toBe("other");
    expect(FINDING_CATEGORY_LABELS[category]).toBe("Other");
  });
});
