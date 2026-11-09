import { safeCountTokens } from "@/lib/token-utils";
import {
  formatUrlContentPage,
  getUrlContentFailure,
  OPEN_URL_OUTPUT_TOKENS,
} from "../utils/url-content";

const getCursor = (result: string) =>
  result.match(/cursor="([A-Za-z0-9_-]+)"/)?.[1];
const getBody = (result: string) =>
  result
    .replace(/^\[Page content tokens \d+-\d+ of \d+\]\n\n/, "")
    .replace(
      /\n\n\[(?:More page content available\.[\s\S]*|End of page content\.)\]$/,
      "",
    );

describe("URL content windows", () => {
  it("returns short code and table content verbatim", () => {
    const content =
      "# Advisory\n\n| Version | Status |\n| --- | --- |\n| 1.2 | fixed |\n\n```http\nGET / HTTP/1.1\n```";
    expect(formatUrlContentPage(content, "https://example.com")).toBe(content);
  });

  it("preserves the entire middle and Unicode across bounded consecutive windows", () => {
    const content =
      "# Security reference\n" +
      "😀 漏洞 café 🧪 payload\n".repeat(4000) +
      "\n## Important final mitigation\nUse prepared statements.";
    let cursor: string | undefined;
    const bodies: string[] = [];
    do {
      const result = formatUrlContentPage(
        content,
        "https://example.com",
        cursor,
      );
      expect(safeCountTokens(result)).toBeLessThanOrEqual(
        OPEN_URL_OUTPUT_TOKENS,
      );
      expect(result).not.toContain("OUTPUT TRUNCATED");
      bodies.push(getBody(result));
      cursor = getCursor(result);
      expect(bodies.length).toBeLessThan(20);
    } while (cursor);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.join("")).toBe(content);
  });

  it("rejects changed content, a cursor from another URL, and malformed cursors", () => {
    const content = "technical details ".repeat(15000);
    const cursor = getCursor(
      formatUrlContentPage(content, "https://example.com"),
    )!;
    for (const result of [
      formatUrlContentPage(content + "updated", "https://example.com", cursor),
      formatUrlContentPage(content, "https://other.example.com", cursor),
    ])
      expect(result).toContain("Page content changed");
    expect(
      formatUrlContentPage(content, "https://example.com", "not a cursor"),
    ).toContain("Invalid continuation cursor");
    expect(
      formatUrlContentPage(
        content,
        "https://example.com",
        Buffer.from('{"offset":null}').toString("base64url"),
      ),
    ).toContain("Invalid continuation cursor");
  });
});

describe("Reader content failures", () => {
  it("rejects HTTP 200 wrappers around upstream errors and browser challenges", () => {
    expect(
      getUrlContentFailure(
        "Title: Not Found\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\nNavigation",
      ),
    ).toContain("HTTP 404");
    expect(
      getUrlContentFailure(
        "Title: Just a moment...\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n\nMarkdown Content:\nPerforming security verification",
      ),
    ).toContain("security verification");
    expect(getUrlContentFailure("   ")).toContain("no page content");
  });

  it("preserves articles that describe CAPTCHA and upstream errors", () => {
    expect(
      getUrlContentFailure(
        "Title: Testing guide\n\nMarkdown Content:\nWarning: Target URL returned error 403\nThis example discusses CAPTCHA and Performing security verification.",
      ),
    ).toBeUndefined();
  });
});
