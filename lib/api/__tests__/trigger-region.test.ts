import { getTriggerRegionForVercelRequest } from "../trigger-region";

function requestWithHeaders(headers: Record<string, string | undefined>) {
  return {
    headers: new Headers(
      Object.entries(headers).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

describe("getTriggerRegionForVercelRequest", () => {
  test("routes European requests to eu-central-1", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": "EU",
        }),
      ),
    ).toBe("eu-central-1");
  });

  test("uses the dashboard default region for North American requests", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": "NA",
        }),
      ),
    ).toBeUndefined();
  });

  test("uses the dashboard default region when Vercel headers are unavailable", () => {
    expect(
      getTriggerRegionForVercelRequest(requestWithHeaders({})),
    ).toBeUndefined();
  });

  test("normalizes Vercel header values", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": " eu ",
        }),
      ),
    ).toBe("eu-central-1");
  });
});
