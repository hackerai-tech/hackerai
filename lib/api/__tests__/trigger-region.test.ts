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

  test("routes non-European requests to us-east-1", () => {
    expect(
      getTriggerRegionForVercelRequest(
        requestWithHeaders({
          "x-vercel-ip-continent": "NA",
        }),
      ),
    ).toBe("us-east-1");
  });

  test("defaults to us-east-1 when Vercel headers are unavailable", () => {
    expect(getTriggerRegionForVercelRequest(requestWithHeaders({}))).toBe(
      "us-east-1",
    );
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
