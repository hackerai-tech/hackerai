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

  it("drops file storage quota errors", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"STORAGE_LIMIT_EXCEEDED","message":"Storage limit exceeded. You are using 10.00 GB of 10 GB and this file requires 37.94 MB. Please delete some files to upload new ones."}',
        },
      }),
    ).toBe(true);
  });

  it("drops expected upload validation errors", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"INVALID_FILE_SIZE","message":"A positive file size is required before generating an upload URL"}',
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            "Uncaught Error: Batch size exceeds limit: Maximum 50 files allowed per request",
        },
      }),
    ).toBe(true);
  });

  it("drops expected chat authorization errors", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"CHAT_UNAUTHORIZED","message":"You don\\u0027t have permission to access this chat"}',
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"CHAT_ACCESS_SUSPENDED","message":"Your account has been suspended due to a fraudulent payment dispute (chargeback)."}',
        },
      }),
    ).toBe(true);
  });

  it("drops Convex optimistic concurrency retries from file upload metadata", () => {
    expect(
      shouldDropExpectedConvexException({
        event: "$exception",
        properties: {
          $exception_message:
            'Documents read from or written to the "btreeNode" table changed while this mutation was being run and on every subsequent retry.',
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
