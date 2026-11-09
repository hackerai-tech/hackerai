import type { ModelMessage, UIMessage } from "ai";
import { getProviderFailedImageReferenceDiagnostics as diagnose } from "../provider-failed-image-reference";

const now = Date.parse("2026-11-09T12:48:00Z");
const expired =
  "https://private.invalid/PRIVATE_USER?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261109T110000Z&X-Amz-Expires=3600&X-Amz-Signature=PRIVATE_SECRET";
const later =
  "https://private.invalid/PRIVATE_TOOL?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261109T120000Z&X-Amz-Expires=3600&X-Amz-Signature=PRIVATE_SECRET";
const request: ModelMessage[] = [
  { role: "user", content: [{ type: "image", image: expired }] },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "t",
        toolName: "image",
        output: { type: "content", value: [{ type: "image-url", url: later }] },
      },
    ],
  },
];
const source: UIMessage[] = [
  {
    id: "private",
    role: "user",
    parts: [
      Object.assign(
        { type: "file" as const, mediaType: "image/png", url: expired },
        { fileId: "PRIVATE_FILE_ID" },
      ),
    ],
  },
];
const error = (message: string) => ({
  name: "AI_APICallError",
  statusCode: 400,
  responseBody: JSON.stringify({ error: { message } }),
});
const failure = (url: string) =>
  error(`Error fetching image from URL '${url}': HTTP403`);

it.each([
  [expired, "user_image_parts", "url_expiry_hint_expired_images", 1],
  [later, "tool_image_parts", "url_expiry_hint_later_images", 0],
])(
  "attributes only the explicit failed URL, not all expired inputs (%#)",
  (url, role, expiry, refs) => {
    const e = failure(url);
    const before = JSON.stringify({ e, request, source });
    const d = diagnose(e, request, source, now);
    expect(d).toMatchObject({
      diagnostic_version: 1,
      status: "matched",
      candidate_count: "one",
      observation: "error_boundary",
      matches: {
        image_parts: 1,
        [role]: 1,
        [expiry]: 1,
        user_url_images_with_file_reference_match: refs,
      },
    });
    expect(JSON.stringify(d)).not.toMatch(
      /PRIVATE|private|https|X-Amz|Signature/,
    );
    expect(JSON.stringify({ e, request, source })).toBe(before);
  },
);

it.each([
  ["Error fetching image: [Redacted signed URL] HTTP403", "redacted"],
  ["Error fetching image: HTTP403", "unavailable"],
  [`Error fetching image ${expired} ${later} HTTP403`, "ambiguous"],
  [
    "Error fetching image https://private.invalid/not-in-input HTTP403",
    "unmatched",
  ],
])(
  "keeps missing/ambiguous references explicit without manufacturing matches (%#)",
  (message, status) => {
    const d = diagnose(error(message), request, source, now);
    expect(d?.status).toBe(status);
    if (status !== "unmatched") expect(d).not.toHaveProperty("matches");
    else expect(d).toMatchObject({ matches: { image_parts: 0 } });
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE|private|https/);
  },
);

it("reads a structured provider raw message before redaction without returning it", () => {
  const e = {
    cause: {
      responseBody: JSON.stringify({
        error: {
          message: "Provider returned error",
          metadata: {
            raw: JSON.stringify({
              error: { message: `Failed to download image '${expired}':403` },
            }),
          },
        },
      }),
    },
  };
  expect(diagnose(e, request, source, now)).toMatchObject({
    status: "matched",
    matches: { user_image_parts: 1 },
  });
});

it("deduplicates candidate occurrences but counts every matching input role", () => {
  const e = { errors: [failure(expired), failure(expired)] };
  const messages: ModelMessage[] = [
    ...request,
    {
      role: "assistant",
      content: [{ type: "image", image: new URL(expired) }],
    },
  ];
  expect(diagnose(e, messages, source, now)).toMatchObject({
    status: "matched",
    candidate_count: "one",
    matches: { image_parts: 2, user_image_parts: 1, assistant_image_parts: 1 },
  });
});

it("does not guess for unrelated errors or read arbitrary request payload fields", () => {
  expect(
    diagnose(error("Invalid image"), request, source, now),
  ).toBeUndefined();
  expect(
    diagnose(
      {
        requestBodyValues: {
          error: { message: `Error fetching image '${expired}'` },
        },
      },
      request,
      source,
      now,
    ),
  ).toBeUndefined();
});

it("distinguishes unavailable source context from an explicit empty file-reference snapshot", () => {
  expect(
    diagnose(failure(expired), request, undefined, now),
  ).not.toHaveProperty("matches.user_url_images_with_file_reference_match");
  expect(diagnose(failure(expired), request, [], now)).toMatchObject({
    matches: {
      user_url_images_with_file_reference_match: 0,
      user_url_images_without_file_reference_match: 1,
    },
  });
});

it("bounds the complete error graph and total inspected text, not each nested message", () => {
  const many = { errors: Array.from({ length: 20 }, () => failure(expired)) };
  expect(diagnose(many, request, source, now)).toMatchObject({
    status: "bounded",
  });
  expect(
    diagnose(
      error("Error fetching image " + "x".repeat(70_000)),
      request,
      source,
      now,
    ),
  ).toMatchObject({ status: "bounded" });
});

it("does not invoke error getters, recurse through cycles or change a diagnostic failure into behavior", () => {
  const getter = jest.fn(() => {
    throw new Error("PRIVATE");
  });
  const e = Object.defineProperty({}, "responseBody", { get: getter });
  expect(() => diagnose(e, request, source, now)).not.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cyclic: any = failure(expired);
  cyclic.cause = cyclic;
  expect(diagnose(cyclic, request, source, now)).toMatchObject({
    status: "matched",
  });
});

it("preserves literal apostrophes inside a quoted URL instead of matching an input prefix", () => {
  const url = "https://private.invalid/object'part?X-Amz-Signature=PRIVATE";
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", image: url },
        { type: "image", image: "https://private.invalid/object" },
      ],
    },
  ];
  expect(diagnose(failure(url), messages, [], now)).toMatchObject({
    status: "matched",
    matches: { image_parts: 1 },
  });
});

it("does not invoke a retry array's length getter while inspecting the bounded graph", () => {
  const get = jest.fn(
    (target: unknown[], key: string | symbol, receiver: unknown) =>
      Reflect.get(target, key, receiver),
  );
  const errors = new Proxy([failure(expired)], { get });
  expect(diagnose({ errors }, request, source, now)).toMatchObject({
    status: "matched",
  });
  expect(get).not.toHaveBeenCalled();
});

it("does not attribute an explicit input beside an unresolved redacted failure candidate", () => {
  const d = diagnose(
    error(
      `Error fetching image [Redacted signed URL]; another URL '${expired}'`,
    ),
    request,
    source,
    now,
  );
  expect(d).toMatchObject({ status: "ambiguous", candidate_count: "one" });
  expect(d).not.toHaveProperty("matches");
});
