import {
  allocateNetInvoice,
  normalizeConvexInvoices,
  prepareOperatingImport,
  type ConvexBillingInvoice,
} from "../operating-costs";

const invoice = (
  reference: string,
  totalDollars: number,
  parts: ConvexBillingInvoice["parts"],
  status: ConvexBillingInvoice["status"] = "billed",
): ConvexBillingInvoice => ({
  reference,
  totalDollars,
  subtotalDollars: parts.reduce((n, part) => n + part.subtotalDollars, 0),
  parts,
  status,
  currency: "USD",
});
const prior = { start: "2026-10-01", end: "2026-11-01", subtotalDollars: 100 };
const current = {
  start: "2026-11-01",
  end: "2026-12-01",
  subtotalDollars: 100,
};
const future = { start: "2026-12-01", end: "2027-01-01", subtotalDollars: 100 };
const cents = (rows: ReturnType<typeof normalizeConvexInvoices>) =>
  rows.reduce(
    (n, row) =>
      n +
      Math.round((row.billedCostDollars ?? row.effectiveCostDollars!) * 100),
    0,
  );

test("net invoice credits are allocated across service periods without losing a cent", () => {
  const amounts = allocateNetInvoice(
    invoice("net", 97.21, [
      { ...prior, subtotalDollars: 40 },
      { ...current, subtotalDollars: 60 },
    ]),
  );
  expect(amounts).toEqual([38.88, 58.33]);
  expect(
    allocateNetInvoice(invoice("rounding", 9.99, [prior, current])),
  ).toEqual([5, 4.99]);
});

test("a fully credited invoice remains zero and a net credit preserves its sign", () => {
  expect(allocateNetInvoice(invoice("fully-credited", 0, [prior]))).toEqual([
    0,
  ]);
  expect(allocateNetInvoice(invoice("credit", -1, [prior, current]))).toEqual([
    -0.5, -0.5,
  ]);
});

test("the previous minimum plus its overage is counted once, and the next minimum stays in its own period", () => {
  const rows = normalizeConvexInvoices(
    [
      {
        teamId: 1,
        invoices: [
          invoice("previous-minimum", 100, [prior]),
          invoice("issued", 130, [{ ...prior, subtotalDollars: 30 }, current]),
          invoice(
            "upcoming",
            100,
            [{ ...current, subtotalDollars: 0 }, future],
            "estimated",
          ),
        ],
      },
    ],
    [1],
    "2026-10-01",
    "2026-11-30",
  );
  expect(cents(rows.filter((row) => row.day.startsWith("2026-10")))).toBe(
    13000,
  );
  expect(cents(rows.filter((row) => row.day.startsWith("2026-11")))).toBe(
    10000,
  );
  expect(
    rows
      .filter((row) => row.day.startsWith("2026-11"))
      .every((row) => row.costStatus === "estimated"),
  ).toBe(true);
  expect(rows.every((row) => row.day < "2026-12-01")).toBe(true);
});

test("seat prorations can overlap a monthly base charge and preserve both invoice totals", () => {
  const rows = normalizeConvexInvoices(
    [
      {
        teamId: 1,
        invoices: [
          invoice("base", 30, [
            { start: "2026-11-01", end: "2026-12-01", subtotalDollars: 30 },
          ]),
          invoice("new-seat", 15, [
            { start: "2026-11-16", end: "2026-12-01", subtotalDollars: 15 },
          ]),
        ],
      },
    ],
    [1],
    "2026-11-01",
    "2026-11-30",
  );
  expect(cents(rows)).toBe(4500);
  expect(rows.find((row) => row.day === "2026-11-15")?.billedCostDollars).toBe(
    1,
  );
  expect(rows.find((row) => row.day === "2026-11-16")?.billedCostDollars).toBe(
    2,
  );
});

test("two billing accounts have independent cost identities and cannot silently omit one", () => {
  const accounts = [1, 2].map((teamId) => ({
    teamId,
    invoices: [
      invoice("same-id-in-different-account", 31, [
        { ...prior, subtotalDollars: 31 },
      ]),
    ],
  }));
  const rows = normalizeConvexInvoices(
    accounts,
    [1, 2],
    "2026-10-01",
    "2026-10-31",
  );
  expect(rows).toHaveLength(62);
  expect(cents(rows)).toBe(6200);
  expect(new Set(rows.map((row) => row.serviceName)).size).toBe(2);
  expect(() =>
    normalizeConvexInvoices(
      accounts.slice(0, 1),
      [1, 2],
      "2026-10-01",
      "2026-10-31",
    ),
  ).toThrow("account scope");
});

test("duplicate invoices and incomplete service-period coverage fail before any write", () => {
  const one = invoice("same", 31, [{ ...prior, subtotalDollars: 31 }]);
  expect(() =>
    normalizeConvexInvoices(
      [{ teamId: 1, invoices: [one, one] }],
      [1],
      "2026-10-01",
      "2026-10-31",
    ),
  ).toThrow("Duplicate");
  expect(() =>
    normalizeConvexInvoices(
      [{ teamId: 1, invoices: [one] }],
      [1],
      "2026-09-30",
      "2026-10-31",
    ),
  ).toThrow("missing account/day");
});

test.each([NaN, Infinity, undefined, 1.001])(
  "invalid net totals cannot become a zero expense: %s",
  (amount) => {
    expect(() =>
      allocateNetInvoice(invoice("bad", amount as number, [prior])),
    ).toThrow();
  },
);

test("no service-period basis cannot receive an unexplained nonzero invoice amount", () => {
  expect(() =>
    allocateNetInvoice(
      invoice("missing", 1, [{ ...prior, subtotalDollars: 0 }]),
    ),
  ).toThrow("no service-period allocation");
  expect(
    allocateNetInvoice(invoice("zero", 0, [{ ...prior, subtotalDollars: 0 }])),
  ).toEqual([0]);
});

test("missing service-period parts cannot silently allocate the whole net invoice to the remaining period", () => {
  const complete = invoice("complete", 90, [
    { ...prior, subtotalDollars: 40 },
    { ...current, subtotalDollars: 60 },
  ]);
  expect(() =>
    allocateNetInvoice({ ...complete, parts: complete.parts.slice(0, 1) }),
  ).toThrow("do not match its subtotal");
});

test("signed invoice URLs cannot enter analytics as invoice references", () => {
  expect(() =>
    allocateNetInvoice({
      ...invoice("safe", 100, [prior]),
      reference: "https://example.invalid/view?token=private",
    }),
  ).toThrow("Invalid Convex invoice");
});

test("canonical Convex snapshots validate the configured billing-account set", () => {
  const snapshot = {
    vendor: "convex",
    observedAt: "2026-11-12T18:00:00Z",
    startDay: "2026-10-01",
    endDay: "2026-10-31",
    convexBilling: [
      {
        teamId: 1,
        invoices: [invoice("source", 31, [{ ...prior, subtotalDollars: 31 }])],
      },
    ],
  };
  expect(
    prepareOperatingImport(
      snapshot,
      { convexTeamIds: [1] },
      Date.parse("2026-11-12T19:00:00Z"),
    ).rows,
  ).toHaveLength(31);
  expect(() =>
    prepareOperatingImport(
      snapshot,
      { convexTeamIds: [1, 2] },
      Date.parse("2026-11-12T19:00:00Z"),
    ),
  ).toThrow("account scope");
});
