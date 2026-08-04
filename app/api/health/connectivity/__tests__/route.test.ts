import { HEAD } from "../route";
import { afterAll, beforeAll } from "@jest/globals";

const originalResponse = globalThis.Response;

beforeAll(() => {
  Object.defineProperty(globalThis, "Response", {
    configurable: true,
    value: class TestResponse {
      status: number;
      headers: Headers;

      constructor(_body: BodyInit | null, init?: ResponseInit) {
        this.status = init?.status ?? 200;
        this.headers = new Headers(init?.headers);
      }

      async text() {
        return "";
      }
    },
  });
});

afterAll(() => {
  if (originalResponse) {
    Object.defineProperty(globalThis, "Response", {
      configurable: true,
      value: originalResponse,
    });
  } else {
    Reflect.deleteProperty(globalThis, "Response");
  }
});

describe("HEAD /api/health/connectivity", () => {
  it("returns a non-cacheable empty success response", async () => {
    const response = await HEAD();

    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });
});
