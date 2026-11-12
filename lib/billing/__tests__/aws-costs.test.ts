/** @jest-environment node */
import type {
  CostExplorerClient,
  GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { fetchAwsCostWindow, normalizeAwsCostPages } from "../aws-costs";

const page = (
  day: string,
  service: string,
  value: string,
  entity = "Usage",
): GetCostAndUsageCommandOutput => ({
  $metadata: {},
  GroupDefinitions: [
    { Type: "DIMENSION", Key: "SERVICE" },
    { Type: "DIMENSION", Key: "RECORD_TYPE" },
  ],
  ResultsByTime: [
    {
      TimePeriod: {
        Start: day,
        End: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10),
      },
      Estimated: true,
      Groups: [
        {
          Keys: [service, entity],
          Metrics: { UnblendedCost: { Amount: value, Unit: "USD" } },
        },
      ],
    },
  ],
});

const marketplace = (value = "0") => ({
  $metadata: {},
  ResultsByTime: [
    {
      TimePeriod: { Start: "2026-11-10", End: "2026-11-11" },
      Total: { UnblendedCost: { Amount: value, Unit: "USD" } },
    },
  ],
});

test("collects every page under the explicit account filter and preserves signed fractional charges", async () => {
  const first = {
    ...page("2026-11-10", "Compute", "3.123456"),
    NextPageToken: "next",
  };
  const second = page("2026-11-10", "Storage", "-0.123456");
  const send = jest
    .fn()
    .mockResolvedValueOnce(marketplace())
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second);
  const rows = await fetchAwsCostWindow(
    { send } as unknown as CostExplorerClient,
    "123456789012",
    "2026-11-10",
    "2026-11-10",
  );
  expect(rows.map((row) => row.effectiveCostDollars)).toEqual([
    3.123456, -0.123456,
  ]);
  expect(rows.reduce((n, row) => n + row.effectiveCostDollars!, 0)).toBe(3);
  expect(send.mock.calls[1][0].input).toEqual(
    expect.objectContaining({
      TimePeriod: { Start: "2026-11-10", End: "2026-11-11" },
      Metrics: ["UnblendedCost"],
      Filter: {
        Dimensions: { Key: "LINKED_ACCOUNT", Values: ["123456789012"] },
      },
    }),
  );
  expect(send.mock.calls[2][0].input.NextPageToken).toBe("next");
  expect(rows.every((row) => row.costStatus === "estimated")).toBe(true);
});

test("partial pagination cannot be mistaken for complete date coverage", async () => {
  const partial = {
    ...page("2026-11-10", "Compute", "3"),
    NextPageToken: "again",
  };
  expect(() =>
    normalizeAwsCostPages([partial], "2026-11-10", "2026-11-10"),
  ).toThrow("pagination");
  const send = jest
    .fn()
    .mockResolvedValueOnce(marketplace())
    .mockResolvedValue(partial);
  await expect(
    fetchAwsCostWindow(
      { send } as unknown as CostExplorerClient,
      "123456789012",
      "2026-11-10",
      "2026-11-10",
    ),
  ).rejects.toThrow("did not advance");
  expect(send).toHaveBeenCalledTimes(3);
});

test("unknown or duplicate costs, missing dates and Marketplace charges cannot replace known data", () => {
  const valid = page("2026-11-10", "Compute", "3");
  expect(() =>
    normalizeAwsCostPages([valid], "2026-11-09", "2026-11-10"),
  ).toThrow("missing days");
  expect(() =>
    normalizeAwsCostPages([valid, valid], "2026-11-10", "2026-11-10"),
  ).toThrow("Duplicate");
  for (const value of ["", "NaN", "Infinity"]) {
    expect(() =>
      normalizeAwsCostPages(
        [page("2026-11-10", "Compute", value)],
        "2026-11-10",
        "2026-11-10",
      ),
    ).toThrow();
  }
  const currency = page("2026-11-10", "Compute", "3");
  currency.ResultsByTime![0].Groups![0].Metrics!.UnblendedCost.Unit = "EUR";
  expect(() =>
    normalizeAwsCostPages([currency], "2026-11-10", "2026-11-10"),
  ).toThrow("currency");
});

test("empty groups require an explicit zero total and cannot mask a subsequent charge page", () => {
  const empty = page("2026-11-10", "Compute", "3");
  empty.ResultsByTime![0].Groups = [];
  expect(() =>
    normalizeAwsCostPages([empty], "2026-11-10", "2026-11-10"),
  ).toThrow("missing days");
  empty.ResultsByTime![0].Total = {
    UnblendedCost: { Amount: "0", Unit: "USD" },
  };
  expect(normalizeAwsCostPages([empty], "2026-11-10", "2026-11-10")).toEqual([
    expect.objectContaining({ effectiveCostDollars: 0 }),
  ]);
  const real = page("2026-11-10", "Compute", "3");
  expect(
    normalizeAwsCostPages([empty, real], "2026-11-10", "2026-11-10"),
  ).toHaveLength(1);
});

test("Marketplace costs stop the import before directly collected vendors can be duplicated", async () => {
  const send = jest.fn().mockResolvedValueOnce(marketplace("1"));
  await expect(
    fetchAwsCostWindow(
      { send } as unknown as CostExplorerClient,
      "123456789012",
      "2026-11-10",
      "2026-11-10",
    ),
  ).rejects.toThrow("reconciliation");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].input.Filter).toEqual({
    And: [
      { Dimensions: { Key: "LINKED_ACCOUNT", Values: ["123456789012"] } },
      { Dimensions: { Key: "BILLING_ENTITY", Values: ["AWS Marketplace"] } },
    ],
  });
});
