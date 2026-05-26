import { shouldDropExpectedConvexException } from "../expected-convex-errors";

describe("shouldDropExpectedConvexException", () => {
  it("drops paid-plan upload errors from nested exception values", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_list: [
            {
              value:
                'Uncaught ConvexError: {"code":"PAID_PLAN_REQUIRED","message":"Paid plan required for file uploads"}',
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("drops file token limit errors even when PostHog nests the message", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_stack_trace: {
            values: [
              {
                value:
                  'Uncaught ConvexError: {"code":"FILE_TOKEN_LIMIT_EXCEEDED","message":"File \\"semgrep-postmessage-report.html\\" exceeds the maximum token limit of 100,000 tokens. Current tokens: 156,123."}',
              },
            ],
          },
        },
      }),
    ).toBe(true);
  });

  it("drops cloud upload rate-limit errors", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"FILE_UPLOAD_RATE_LIMIT","message":"You\\u0027ve reached your cloud file upload limit of 400 files per 5 hours."}',
        },
      }),
    ).toBe(true);
  });

  it("keeps non-exception events with matching text", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "file_upload_failed",
        properties: {
          message: "PAID_PLAN_REQUIRED",
        },
      }),
    ).toBe(false);
  });

  it("keeps unexpected exceptions", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message: "Uncaught TypeError: Cannot read properties",
        },
      }),
    ).toBe(false);
  });
});
