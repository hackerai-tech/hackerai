import { shouldDropExpectedFrontendException } from "../expected-frontend-exceptions";

describe("shouldDropExpectedFrontendException", () => {
  it("keeps non-exception events", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "chat_error",
        properties: {
          message:
            "ResizeObserver loop completed with undelivered notifications.",
        },
      }),
    ).toBe(false);
  });

  it("keeps unexpected frontend exceptions", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Cannot read properties of undefined"],
        },
      }),
    ).toBe(false);
  });

  it("keeps generic network and chunk-load failures", () => {
    for (const value of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "network error",
      "Failed to load chunk /_next/static/chunks/example.js from module 1",
    ]) {
      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_values: [value],
          },
        }),
      ).toBe(false);
    }
  });

  it("drops expected Convex exceptions through the shared Convex classifier", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_message:
            'Uncaught ConvexError: {"code":"CHAT_ACCESS_SUSPENDED","message":"Suspended"}',
        },
      }),
    ).toBe(true);
  });

  it("drops browser ResizeObserver notifications", () => {
    for (const value of [
      "ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop limit exceeded",
    ]) {
      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_values: [value],
          },
        }),
      ).toBe(true);
    }
  });

  it("drops manual chat stop aborts only when the stack is app-owned", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["AbortError: Fetch is aborted"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "turbopack:///[project]/app/hooks/useChatHandlers.ts",
                    resolved_name: "handleStop",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["AbortError: Fetch is aborted"],
        },
      }),
    ).toBe(false);
  });

  it("drops expected auth refresh failures only with auth stack sources", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Failed to refresh access token"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "turbopack:///[project]/lib/auth/cross-tab-mutex.ts",
                  },
                  {
                    source:
                      "turbopack:///[project]/node_modules/.pnpm/@workos-inc+authkit-nextjs@4.1.4/node_modules/@workos-inc/authkit-nextjs/src/components/tokenStore.ts",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Failed to refresh access token"],
        },
      }),
    ).toBe(false);
  });

  it("drops PostHog SDK transport timeouts only with PostHog request frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["PostHog request timed out after 3000ms"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "turbopack:///[project]/node_modules/.pnpm/posthog-js@1.396.2/node_modules/posthog-js/src/request.ts",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["PostHog request timed out after 3000ms"],
        },
      }),
    ).toBe(false);
  });

  it("drops Monaco editor cancellations by source", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_types: ["Canceled"],
          $exception_values: ["Canceled"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "/npm/monaco-editor@0.55.1/min/vs/editor.api-CalNCsUg.js",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_types: ["Canceled"],
          $exception_values: ["Canceled"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source: "turbopack:///[project]/app/components/chat.tsx",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("drops Trigger stream double-close noise only with Trigger stream frames", () => {
    for (const value of [
      "Failed to execute 'close' on 'ReadableStreamDefaultController': Cannot close an errored readable stream",
      "ReadableStreamDefaultController is not in a state where it can be closed",
      "ReadableStreamDefaultController.close: Cannot close a stream that is already closed.",
    ]) {
      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_values: [value],
            $exception_list: [
              {
                stacktrace: {
                  frames: [
                    {
                      source:
                        "turbopack:///[project]/node_modules/.pnpm/@trigger.dev+core@4.4.6/node_modules/@trigger.dev/core/src/v3/streams/asyncIterableStream.ts",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ).toBe(true);

      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_values: [value],
          },
        }),
      ).toBe(false);
    }
  });
});
