import {
  enrichFrontendExceptionEvent,
  sanitizeFrontendExceptionUrlProperties,
  shouldDropExpectedFrontendException,
} from "../expected-frontend-exceptions";
import {
  getComposerChangeDiagnostics,
  recordComposerChange,
} from "../composer-change-diagnostics";

jest.mock("@/lib/analytics/client", () => ({
  getIdentifiedAnalyticsUserId: () => "synthetic-user",
}));

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
          $exception_values: ["Failed to fetch"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    raw_frame: {
                      filename:
                        "https://hackerai.co/_next/static/chunks/27au5l1vw34oq.js?dpl=dpl_2ruEPyNtAD3Yc4qkCoAN2J7ReZk7",
                    },
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

  it("drops transport failures with mixed Next 16.3 server action frames", () => {
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
                    source:
                      "turbopack:///[project]/node_modules/next/src/client/components/router-reducer/reducers/server-action-reducer.ts",
                    junk_drawer: {
                      raw_frame: {
                        filename:
                          "/_next/static/immutable/chunks/0ro0tl16w8mcs.js",
                      },
                    },
                  },
                  {
                    source:
                      "turbopack:///[project]/node_modules/next/src/client/components/segment-cache/fetch.ts",
                    junk_drawer: {
                      raw_frame: {
                        filename:
                          "/_next/static/immutable/chunks/0ro0tl16w8mcs.js",
                      },
                    },
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
                    source:
                      "turbopack:///[project]/node_modules/next/src/client/components/segment-cache/fetch.ts",
                  },
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

  it("drops exceptions whose frames come only from injected third-party scripts", () => {
    for (const source of [
      "moz-extension://example/userscripts/user.js",
      "chrome-extension://example/content.js",
      "iabjs://navigation_performance_logger_android",
    ]) {
      expect(
        shouldDropExpectedFrontendException({
          event: "$exception",
          properties: {
            $exception_values: ["Injected script failure"],
            $exception_list: [
              { stacktrace: { frames: [{ source }, { filename: source }] } },
            ],
          },
        }),
      ).toBe(true);
    }
  });

  it("keeps exceptions with both injected and application frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Application failure"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  { source: "moz-extension://example/userscripts/user.js" },
                  { source: "turbopack:///[project]/app/components/chat.tsx" },
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

  it("keeps stale-looking server action messages with app stack frames", () => {
    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_values: ["Checkout session was not found on the server"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    source: "turbopack:///[project]/app/actions/billing.ts",
                  },
                ],
              },
            },
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
      "NotFoundError: Node.removeChild: The node to be removed is not a child of this node",
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

    expect(
      shouldDropExpectedFrontendException({
        event: "$exception",
        properties: {
          $exception_types: ["DOMException"],
          $exception_values: [
            "NotFoundError: Node.removeChild: Application state is unavailable",
          ],
        },
      }),
    ).toBe(false);
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
        $exception_list: [
          {
            stacktrace: {
              frames: [
                {
                  raw_frame: {
                    filename:
                      "https://hackerai.co/_next/static/chunks/react.js?dpl=dpl_G8NpYMgn7xvPfdr4XW6jYBmeC4yB",
                  },
                },
              ],
            },
          },
        ],
      },
    });

    expect(event.properties).toMatchObject({
      hackerai_exception_category: "react_max_update_depth",
      hackerai_exception_deployment_id: "dpl_G8NpYMgn7xvPfdr4XW6jYBmeC4yB",
      hackerai_route_kind: "chat",
    });
  });

  it("attaches recent composer metadata only to retained React update-depth errors", () => {
    const clock = jest.spyOn(performance, "now").mockReturnValue(10000);
    try {
      recordComposerChange({ inputType: "insertText", isTrusted: true });
      const event = enrichFrontendExceptionEvent({
        event: "$exception",
        properties: { $exception_values: ["Minified React error #185"] },
      });
      expect(event.properties).toMatchObject({
        hackerai_composer_change_recent_count: 1,
        hackerai_composer_change_last_input_type: "insertText",
      });
      expect(shouldDropExpectedFrontendException(event)).toBe(false);
      for (const message of [
        "Maximum call stack size exceeded",
        "Unknown failure",
      ]) {
        const other = enrichFrontendExceptionEvent({
          event: "$exception",
          properties: { $exception_values: [message] },
        });
        expect(
          Object.keys(other.properties).some((key) =>
            key.startsWith("hackerai_composer_change_"),
          ),
        ).toBe(false);
      }
      const ordinary = { event: "chat_user_submission", properties: {} };
      expect(enrichFrontendExceptionEvent(ordinary)).toBe(ordinary);
      expect(ordinary.properties).toEqual({});
    } finally {
      clock.mockReturnValue(16000);
      getComposerChangeDiagnostics();
      clock.mockRestore();
    }
  });

  describe("browser build identity", () => {
    const originalBuildCommit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;

    afterEach(() => {
      if (originalBuildCommit === undefined) {
        delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
      } else {
        process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalBuildCommit;
      }
    });

    it("attributes an SDK-only stack to its own build without a deployment hint", () => {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "a".repeat(40);
      const event = enrichFrontendExceptionEvent({
        event: "$exception",
        properties: {
          $exception_values: ["JSON Parse error: Unterminated string"],
          $exception_list: [
            {
              stacktrace: {
                frames: [
                  {
                    raw_frame: {
                      filename: "convex/src/browser/sync/web_socket_manager.ts",
                    },
                  },
                ],
              },
            },
          ],
        },
      });

      expect(shouldDropExpectedFrontendException(event)).toBe(false);
      expect(event.properties).toMatchObject({
        hackerai_exception_build_commit: "a".repeat(40),
      });
      expect(event.properties).not.toHaveProperty(
        "hackerai_exception_deployment_id",
      );
    });

    it.each([undefined, "", "unrecognized-build"])(
      "does not invent an identity for an unknown build (%s)",
      (buildCommit) => {
        if (buildCommit === undefined) {
          delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
        } else {
          process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = buildCommit;
        }
        const event = enrichFrontendExceptionEvent({
          event: "$exception",
          properties: {},
        });
        expect(event.properties).not.toHaveProperty(
          "hackerai_exception_build_commit",
        );
      },
    );

    it("does not add build metadata to other analytics events", () => {
      process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "a".repeat(40);
      const event = { event: "custom_event", properties: { count: 1 } };
      expect(enrichFrontendExceptionEvent(event)).toBe(event);
      expect(event.properties).toEqual({ count: 1 });
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

  describe("capture-time exception structure", () => {
    const CAPTURE_PREFIX = "hackerai_exception_capture_";
    const appSource = "turbopack:///[project]/app/components/chat.tsx";
    const nextSource =
      "turbopack:///[project]/node_modules/next/src/client/components/segment-cache/fetch.ts";
    const captureFields = (properties: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(properties).filter(([key]) =>
          key.startsWith(CAPTURE_PREFIX),
        ),
      );
    const capture = (properties: Record<string, unknown>) =>
      captureFields(
        enrichFrontendExceptionEvent({ event: "$exception", properties })
          .properties,
      );
    const withFrames = (frames: unknown[]) => ({
      $exception_list: [
        { type: "TypeError", value: "Load failed", stacktrace: { frames } },
      ],
    });

    it("records the list shape that reached enrichment without parsing it", () => {
      class PrivateConstructorName {}
      const cases: [string, Record<string, unknown>][] = [
        ["missing", {}],
        ["missing", { $exception_list: undefined }],
        ["null", { $exception_list: null }],
        ["array_empty", { $exception_list: [] }],
        ["array_one", { $exception_list: [{ type: "TypeError" }] }],
        [
          "array_many",
          { $exception_list: [{ type: "Error" }, { type: "TypeError" }] },
        ],
        ["string", { $exception_list: '[{"type":"TypeError"}]' }],
        ["object", { $exception_list: { 0: { type: "TypeError" } } }],
        ["object", { $exception_list: new PrivateConstructorName() }],
        ["other", { $exception_list: 1 }],
        ["other", { $exception_list: true }],
      ];
      for (const [shape, properties] of cases) {
        const fields = capture(properties);
        expect(fields.hackerai_exception_capture_list_shape).toBe(shape);
        expect(JSON.stringify(fields)).not.toContain("PrivateConstructorName");
      }
    });

    it("distinguishes a serialized list from the direct shape the bare filter drops", () => {
      const entry = {
        type: "TypeError",
        value: "Load failed",
        mechanism: { handled: false },
      };
      const serializedList = JSON.stringify([entry]);
      const direct = {
        event: "$exception",
        properties: { $exception_list: [entry] },
      };
      const serialized = {
        event: "$exception",
        properties: { $exception_list: serializedList },
      };

      expect(shouldDropExpectedFrontendException(direct)).toBe(true);
      expect(shouldDropExpectedFrontendException(serialized)).toBe(false);
      expect(
        captureFields(enrichFrontendExceptionEvent(direct).properties),
      ).toEqual({
        hackerai_exception_capture_version: 1,
        hackerai_exception_capture_list_shape: "array_one",
        hackerai_exception_capture_frame_source_count_bucket: "0",
        hackerai_exception_capture_frame_source_family: "none",
        hackerai_exception_capture_exact_transport_message: true,
      });
      const enriched = enrichFrontendExceptionEvent(serialized);
      expect(captureFields(enriched.properties)).toEqual({
        hackerai_exception_capture_version: 1,
        hackerai_exception_capture_list_shape: "string",
        hackerai_exception_capture_frame_source_count_bucket: "0",
        hackerai_exception_capture_frame_source_family: "none",
        hackerai_exception_capture_exact_transport_message: false,
      });
      expect(enriched.properties.$exception_list).toBe(serializedList);
    });

    it("summarizes the frame sources the existing filters collected", () => {
      const injected = "chrome-extension://PRIVATE/content.js";
      const repeated = (length: number) =>
        Array.from({ length }, () => ({ source: appSource }));
      const cases: [unknown[], string, string][] = [
        [[], "0", "none"],
        [[{ lineno: 1, colno: 2 }], "0", "none"],
        [[{ source: "" }], "1", "all_empty"],
        [[{ source: "" }, { raw_frame: { filename: "" } }], "2_5", "all_empty"],
        [
          [{ source: injected }, { filename: "iabjs://PRIVATE_logger" }],
          "2_5",
          "injected_only",
        ],
        [
          [
            { source: nextSource },
            { raw_frame: { filename: "/_next/static/chunks/PRIVATE.js" } },
          ],
          "2_5",
          "next_pattern_only",
        ],
        [[{ source: nextSource }, { source: appSource }], "2_5", "other"],
        [[{ source: "" }, { source: injected }], "2_5", "other"],
        // The existing collector reads both a frame's source and raw filename.
        [
          [{ source: appSource, raw_frame: { filename: appSource } }],
          "2_5",
          "other",
        ],
        [repeated(1), "1", "other"],
        [repeated(5), "2_5", "other"],
        [repeated(6), "6_16", "other"],
        [repeated(16), "6_16", "other"],
        [repeated(17), "over16", "other"],
      ];
      for (const [frames, bucket, family] of cases) {
        const fields = capture(withFrames(frames));
        expect([
          fields.hackerai_exception_capture_frame_source_count_bucket,
          fields.hackerai_exception_capture_frame_source_family,
        ]).toEqual([bucket, family]);
        expect(JSON.stringify(fields)).not.toMatch(
          /PRIVATE|extension|iabjs|turbopack|_next|project/,
        );
      }
    });

    it("reports only an exact existing transport message", () => {
      const cases: [Record<string, unknown>, boolean][] = [
        [{ $exception_values: ["Load failed"] }, true],
        [{ $exception_values: ["Failed to fetch"] }, true],
        [{ $exception_list: [{ type: "TypeError", value: "timeout" }] }, true],
        [{ $exception_values: ["TypeError: Load failed"] }, false],
        [{ $exception_values: ["Load failed (PRIVATE)"] }, false],
        [{ $exception_values: ["load failed"] }, false],
        [{ $exception_values: ["Unexpected application error"] }, false],
      ];
      for (const [properties, exact] of cases) {
        expect(
          capture(properties)
            .hackerai_exception_capture_exact_transport_message,
        ).toBe(exact);
      }
    });

    it("replaces caller-supplied capture fields before collecting inputs", () => {
      const list = [
        {
          type: "TypeError",
          value: "Unexpected application error",
          stacktrace: { frames: [{ source: appSource }] },
        },
      ];
      const values = ["Unexpected application error"];
      const expected = {
        hackerai_exception_capture_version: 1,
        hackerai_exception_capture_list_shape: "array_one",
        hackerai_exception_capture_frame_source_count_bucket: "1",
        hackerai_exception_capture_frame_source_family: "other",
        hackerai_exception_capture_exact_transport_message: false,
      };
      const enriched = enrichFrontendExceptionEvent({
        event: "$exception",
        properties: {
          $exception_list: list,
          $exception_values: values,
          hackerai_exception_capture_version: 999,
          hackerai_exception_capture_list_shape: "PRIVATE",
          hackerai_exception_capture_exact_transport_message: true,
          hackerai_exception_capture_raw_message: "Load failed",
          hackerai_exception_capture_frames: [
            { source: "chrome-extension://PRIVATE/content.js" },
          ],
        },
      });

      expect(captureFields(enriched.properties)).toEqual(expected);
      expect(JSON.stringify(enriched.properties)).not.toContain("PRIVATE");
      expect(enriched.properties.$exception_list).toBe(list);
      expect(enriched.properties.$exception_values).toBe(values);
      expect(list[0].stacktrace.frames).toEqual([{ source: appSource }]);
      expect(
        captureFields(enrichFrontendExceptionEvent(enriched).properties),
      ).toEqual(expected);
    });

    it("emits only the closed capture fields and leaves filter decisions unchanged", () => {
      const fixtures: (() => Record<string, unknown>)[] = [
        () => ({ $exception_values: ["Load failed"] }),
        () => withFrames([]),
        () => withFrames([{ source: nextSource }]),
        () => withFrames([{ source: "moz-extension://PRIVATE/user.js" }]),
        () => withFrames([{ source: "" }]),
        () => withFrames([{ source: appSource }]),
        () => ({ $exception_list: '[{"value":"Load failed"}]' }),
        () => ({ $exception_values: ["ChunkLoadError"] }),
        () => ({ $exception_values: ["Unexpected application error"] }),
        () => ({ $exception_list: { value: "Failed to fetch" } }),
      ];
      const closed: Record<string, readonly unknown[]> = {
        hackerai_exception_capture_version: [1],
        hackerai_exception_capture_list_shape: [
          "missing",
          "null",
          "array_empty",
          "array_one",
          "array_many",
          "string",
          "object",
          "other",
        ],
        hackerai_exception_capture_frame_source_count_bucket: [
          "0",
          "1",
          "2_5",
          "6_16",
          "over16",
        ],
        hackerai_exception_capture_frame_source_family: [
          "none",
          "all_empty",
          "injected_only",
          "next_pattern_only",
          "other",
        ],
        hackerai_exception_capture_exact_transport_message: [true, false],
      };
      for (const properties of fixtures) {
        const before = shouldDropExpectedFrontendException({
          event: "$exception",
          properties: properties(),
        });
        const enriched = enrichFrontendExceptionEvent({
          event: "$exception",
          properties: properties(),
        });
        expect(shouldDropExpectedFrontendException(enriched)).toBe(before);
        const fields = captureFields(enriched.properties);
        expect(Object.keys(fields).sort()).toEqual(Object.keys(closed).sort());
        for (const [key, value] of Object.entries(fields)) {
          expect(closed[key]).toContain(value);
        }
      }
      const ordinary = { event: "custom_event", properties: { count: 1 } };
      expect(enrichFrontendExceptionEvent(ordinary).properties).toEqual({
        count: 1,
      });
    });
  });

  it("removes query strings and fragments from retained exception URLs", () => {
    const event = sanitizeFrontendExceptionUrlProperties({
      event: "$exception",
      properties: {
        $current_url:
          "https://hackerai.co/auth-error?state=secret#client_redirect_key=secret",
        $referrer: "https://idp.example/callback?code=secret&state=secret",
        $exception_values: [
          "Request failed for https://api.example/resource?diagnostic=keep",
        ],
      },
    });

    expect(event.properties).toEqual({
      $current_url: "https://hackerai.co/auth-error",
      $referrer: "https://idp.example/callback",
      $exception_values: [
        "Request failed for https://api.example/resource?diagnostic=keep",
      ],
    });
  });

  it("does not change URL properties on non-exception events", () => {
    const event = {
      event: "custom_event",
      properties: {
        $current_url: "https://hackerai.co/c/chat-123?tab=files",
        $referrer: "https://hackerai.co/?source=home",
      },
    };

    expect(sanitizeFrontendExceptionUrlProperties(event)).toBe(event);
    expect(event.properties.$current_url).toContain("?tab=files");
    expect(event.properties.$referrer).toContain("?source=home");
  });
});
