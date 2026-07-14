import { reportToolFailure } from "../tool-failure";

const failure = {
  event: "web_search_provider_failed",
  tool_name: "web_search",
  provider: "perplexity",
};

describe("reportToolFailure", () => {
  test("dispatches failure reporting without awaiting the logger", () => {
    const onToolFailure = jest.fn(() => new Promise<void>(() => {}));

    expect(reportToolFailure(onToolFailure, failure)).toBeUndefined();
    expect(onToolFailure).toHaveBeenCalledWith(failure);
  });

  test("swallows logger errors so tool results are unchanged", () => {
    const onToolFailure = jest.fn(() => {
      throw new Error("metadata unavailable");
    });

    expect(() => reportToolFailure(onToolFailure, failure)).not.toThrow();
  });
});
