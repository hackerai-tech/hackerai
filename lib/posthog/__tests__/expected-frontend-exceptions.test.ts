import {
  enrichFrontendExceptionEvent,
  shouldDropExpectedFrontendException,
} from "../expected-frontend-exceptions";

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

  it("drops bare generic network and chunk-load failures", () => {
    for (const value of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "network error",
      "Error in input stream",
      "timeout",
      "connection closed",
      "An unexpected response was received from the server.",
      "Failed to load chunk /_next/static/chunks/example.js from module 1",
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

  it("keeps generic network failures with app stack frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Failed to fetch"],
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

  it("drops Next server action transport and stale deployment failures", () => {
    for (const value of [
      "Failed to fetch",
      "An unexpected response was received from the server.",
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
                        "turbopack:///[project]/node_modules/.pnpm/next@16.2.9/node_modules/next/src/client/components/router-reducer/reducers/server-action-reducer.ts",
                    },
                  ],
                },
              },
            ],
          },
        }),
      ).toBe(true);
    }

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_types: ["UnrecognizedActionError"],
          $exception_values: [
            'Server Action "00b3ff60fce156a3bb78260aa8fa56550dc48b7f77" was not found on the server. Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
          ],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source: "/docs/messages/failed-to-find-server-action",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("keeps generic network failures when a server action failure has app frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Failed to fetch"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source: "turbopack:///[project]/app/actions/example.ts",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("keeps non-stale server action failures", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: [
            "Server Action failed while creating a checkout session",
          ],
        },
      }),
    ).toBe(false);
  });

  it("drops chunk load failures even with Next runtime frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_types: ["ChunkLoadError"],
          $exception_values: [
            "Failed to load chunk /_next/static/chunks/example.js from module 1",
          ],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "turbopack:///[turbopack]/browser/runtime/base/runtime-base.ts",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBe(true);
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

  it("drops exact manual chat stop aborts", () => {
    for (const value of [
      "AbortError: Fetch is aborted",
      "AbortError: signal is aborted without reason",
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

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["AbortError: The user aborted a request."],
        },
      }),
    ).toBe(false);
  });

  it("drops exact React DOM mutation noise", () => {
    for (const value of [
      "NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
      "NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      "NotFoundError: The object can not be found here.",
    ]) {
      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_types: ["DOMException"],
            $exception_values: [value],
          },
        }),
      ).toBe(true);
    }
  });

  it("drops exact opaque synthetic browser exceptions", () => {
    for (const value of [
      "Event captured as exception with keys: isTrusted",
      "'Error' captured as exception with message: 'Aa'",
      "'TypeError' captured as exception with message: 'undefined is not an object (evaluating 'a.J')'",
      "'Error' captured as exception with message: 'Invalid call to runtime.sendMessage(). Tab not found.'",
      "Cannot read properties of undefined (reading 'CoinType')",
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
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source:
                      "turbopack:///[project]/node_modules/.pnpm/@workos-inc+authkit-nextjs@4.1.4_@workos-inc+node@10.7.0/node_modules/@workos-inc/authkit-nextjs/src/components/tokenStore.ts",
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

  it("drops exact Trigger stream double-close noise", () => {
    for (const value of [
      "Failed to execute 'close' on 'ReadableStreamDefaultController': Cannot close an errored readable stream",
      "Failed to execute 'close' on 'ReadableStreamDefaultController': ReadableStreamDefaultController is not in a state where it can be closed",
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
    }
  });

  it("adds structured diagnostics to retained frontend exceptions", () => {
    const event = enrichFrontendExceptionEvent({
      event: "$exception",
      properties: {
        $current_url: "https://hackerai.co/c/chat-123",
        $exception_values: [
          "Minified React error #185; visit https://react.dev/errors/185 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
        ],
      },
    });

    expect(event.properties).toMatchObject({
      hackerai_exception_category: "react_max_update_depth",
      hackerai_route_kind: "chat",
    });
  });

  it("classifies stack overflows across browser wording", () => {
    for (const value of [
      "Maximum call stack size exceeded",
      "Maximum call stack size exceeded.",
      "too much recursion",
    ]) {
      const event = enrichFrontendExceptionEvent({
        event: "$exception",
        properties: {
          $exception_values: [value],
        },
      });

      expect(event.properties).toMatchObject({
        hackerai_exception_category: "stack_overflow",
      });
    }
  });
});
