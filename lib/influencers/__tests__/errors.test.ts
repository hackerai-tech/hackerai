import { influencerErrorSummary } from "../errors";

it("includes bounded diagnostics without SDK message text or arguments", () => {
  const error = Object.assign(
    new Error("Request contained private@example.com and a secret"),
    {
      name: "StripeInvalidRequestError",
      statusCode: 400,
      requestId: "req_123abc",
      raw: { apiKey: "secret" },
    },
  );
  expect(influencerErrorSummary(error)).toEqual({
    name: "StripeInvalidRequestError",
    status: 400,
    requestId: "req_123abc",
  });
  expect(JSON.stringify(influencerErrorSummary(error))).not.toMatch(
    /private|secret|raw/,
  );
  expect(
    influencerErrorSummary({
      name: "private@example.com",
      requestId: "secret",
      statusCode: 999,
    }),
  ).toEqual({ name: "UnknownError" });
});
