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

describe("GET /sitemap.xml", () => {
  it("returns the canonical public URLs as XML", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/xml; charset=utf-8",
    );
    expect(body).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(body).toContain("<loc>https://hackerai.co/</loc>");
    expect(body).toContain("<loc>https://hackerai.co/download</loc>");
    expect(body).toContain("<loc>https://hackerai.co/trust</loc>");
    expect(body).toContain("<loc>https://hackerai.co/privacy-policy</loc>");
    expect(body).toContain("<loc>https://hackerai.co/terms-of-service</loc>");
    expect(body).not.toContain("http://hackerai.co");
  });
});
