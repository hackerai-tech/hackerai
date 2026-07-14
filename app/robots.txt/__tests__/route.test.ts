import { describe, expect, it } from "@jest/globals";
import { GET } from "../route";

class TestResponse {
  readonly headers: Headers;
  readonly status: number;

  constructor(
    private readonly body: string,
    init: ResponseInit = {},
  ) {
    this.headers = new Headers(init.headers);
    this.status = init.status ?? 200;
  }

  async text() {
    return this.body;
  }
}

Object.defineProperty(globalThis, "Response", {
  configurable: true,
  value: TestResponse,
});

describe("GET /robots.txt", () => {
  it("returns crawl rules and the canonical sitemap URL as plain text", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Allow: /");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain("Disallow: /c/");
    expect(body).toContain("Sitemap: https://hackerai.co/sitemap.xml");
  });
});
