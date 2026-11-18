import {
  isBrowserHandoffReadError,
  isTrustedBrowserHandoffReadFailure,
  rethrowBrowserHandoffReadError,
} from "../read-error";
import {
  extractErrorDetails,
  getProviderErrorCategory,
} from "@/lib/utils/error-utils";

/** Brand through the production rethrow, the only way provenance is granted. */
const brand = <T extends object>(error: T): T => {
  try {
    rethrowBrowserHandoffReadError(error);
  } catch (thrown) {
    expect(thrown).toBe(error);
  }
  return error;
};

const disconnect = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });

/** Wrap `inner` so it sits `depth` causal links below the returned failure. */
const nestAt = (inner: unknown, depth: number): unknown => {
  let current = inner;
  for (let level = 0; level < depth; level++)
    current = new Error(`wrapper ${level}`, { cause: current });
  return current;
};

it("trusts a frozen branded failure without wrapping, mutating or reclassifying it", () => {
  const failure = Object.freeze(brand(disconnect()));
  const descriptorsBefore = Object.getOwnPropertyDescriptors(failure);
  const unmarked = disconnect();

  expect(isTrustedBrowserHandoffReadFailure(failure)).toBe(true);
  expect(isTrustedBrowserHandoffReadFailure(unmarked)).toBe(false);
  expect(Object.isFrozen(failure)).toBe(true);
  expect(Object.getOwnPropertyDescriptors(failure)).toEqual(descriptorsBefore);
  // Admission only: provider classification is unchanged by the brand.
  expect(getProviderErrorCategory(extractErrorDetails(failure))).toBe(
    getProviderErrorCategory(extractErrorDetails(unmarked)),
  );
});

it.each([
  ["cause", (inner: unknown) => new Error("stream wrapper", { cause: inner })],
  ["error", (inner: unknown) => ({ type: "error", error: inner })],
  [
    "aggregate first",
    (inner: unknown) => new AggregateError([inner], "retry exhausted"),
  ],
  [
    "aggregate fifth",
    (inner: unknown) =>
      new AggregateError(
        [disconnect(), disconnect(), disconnect(), disconnect(), inner],
        "retry exhausted",
      ),
  ],
])("trusts a branded source nested through own %s data", (_kind, wrap) => {
  const branded = Object.freeze(brand(disconnect()));
  expect(isTrustedBrowserHandoffReadFailure(wrap(branded))).toBe(true);
  expect(isTrustedBrowserHandoffReadFailure(wrap(disconnect()))).toBe(false);
});

it("stops at the same causal reach as extracted error origin", () => {
  for (const depth of [0, 1, 2, 3, 4, 5, 6]) {
    const failure = nestAt(brand(disconnect()), depth);
    const reached = depth <= 4;
    expect([depth, isTrustedBrowserHandoffReadFailure(failure)]).toEqual([
      depth,
      reached,
    ]);
    expect([depth, extractErrorDetails(failure).errorOrigin]).toEqual([
      depth,
      reached ? "browser_handoff_read" : undefined,
    ]);
  }
});

it("ignores aggregate errors beyond the first five", () => {
  const sixth = new AggregateError(
    [...Array.from({ length: 5 }, disconnect), brand(disconnect())],
    "retry exhausted",
  );
  expect(isTrustedBrowserHandoffReadFailure(sixth)).toBe(false);
});

it("terminates on causal cycles and still finds a branded source past one", () => {
  const first = new Error("first") as Error & { cause?: unknown };
  const second = new Error("second", { cause: first });
  first.cause = second;
  expect(isTrustedBrowserHandoffReadFailure(first)).toBe(false);

  const withBrandedSibling = new AggregateError(
    [first, brand(disconnect())],
    "retry exhausted",
  );
  expect(isTrustedBrowserHandoffReadFailure(withBrandedSibling)).toBe(true);
});

it("finds a branded source through a shared node first reached by a deeper path", () => {
  // Shortest path: graph.cause -> shared -> {cause} -> branded (depth 3).
  // The `error` path reaches `shared` first at depth 3, where branded is out of reach.
  const shared = { cause: { cause: brand(disconnect()) } };
  const graph = { error: { cause: { cause: shared } }, cause: shared };
  expect(isTrustedBrowserHandoffReadFailure(graph)).toBe(true);

  // The same graph beyond depth 4 on every path stays out of reach.
  const deep = { error: { cause: { cause: { cause: shared } } } };
  expect(isTrustedBrowserHandoffReadFailure(deep)).toBe(false);
});

it("never invokes or trusts accessor, inherited or spoofed provenance", () => {
  const branded = brand(disconnect());
  const getter = jest.fn(() => branded);
  const accessor = Object.defineProperty(new Error("wrapper"), "cause", {
    get: getter,
  });
  const inherited = Object.create({ cause: branded }) as object;
  const spoofed = Object.assign(new Error("spoofed"), {
    origin: "browser_handoff_read",
    errorOrigin: "browser_handoff_read",
  });

  expect(isTrustedBrowserHandoffReadFailure(accessor)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(isTrustedBrowserHandoffReadFailure(inherited)).toBe(false);
  expect(isTrustedBrowserHandoffReadFailure(spoofed)).toBe(false);
  expect(
    isTrustedBrowserHandoffReadFailure({
      origin: "browser_handoff_read",
      cause: { errorOrigin: "browser_handoff_read" },
    }),
  ).toBe(false);
});

it("treats throwing or revoked proxies as unproven without hiding a branded sibling", () => {
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("trap");
      },
    },
  );
  const revoked = Proxy.revocable([] as unknown[], {});
  revoked.revoke();

  expect(isTrustedBrowserHandoffReadFailure(hostile)).toBe(false);
  expect(
    isTrustedBrowserHandoffReadFailure({
      errors: revoked.proxy,
      cause: hostile,
    }),
  ).toBe(false);
  expect(
    isTrustedBrowserHandoffReadFailure(
      new AggregateError([hostile, brand(disconnect())], "retry exhausted"),
    ),
  ).toBe(true);
});

it("checks each supplied failure independently", () => {
  const unrelated = Object.assign(new Error("Upstream unavailable"), {
    statusCode: 503,
  });
  const branded = brand(disconnect());

  expect(isTrustedBrowserHandoffReadFailure(unrelated, branded)).toBe(true);
  expect(isTrustedBrowserHandoffReadFailure(branded, undefined)).toBe(true);
  expect(isTrustedBrowserHandoffReadFailure(undefined, unrelated)).toBe(false);
  expect(isTrustedBrowserHandoffReadFailure()).toBe(false);
  // The direct brand check is unchanged and still identity-only.
  expect(isBrowserHandoffReadError(new Error("x", { cause: branded }))).toBe(
    false,
  );
});
