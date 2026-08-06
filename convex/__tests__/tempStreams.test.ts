import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockValidateServiceKey = jest.fn();

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
  query: jest.fn((config) => config),
}));

jest.mock("convex/values", () => ({
  v: new Proxy(
    {},
    {
      get: () => jest.fn(() => "validator"),
    },
  ),
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: mockValidateServiceKey,
}));

describe("legacy temp stream cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("inspects legacy rows through bounded pagination", async () => {
    const paginate = jest.fn().mockResolvedValue({
      page: [{ _id: "temp-1" }, { _id: "temp-2" }],
      isDone: false,
      continueCursor: "next-cursor",
    });
    const order = jest.fn(() => ({ paginate }));
    const query = jest.fn(() => ({ order }));
    const { inspectLegacyTempStreams } = await import("../tempStreams");

    await expect(
      inspectLegacyTempStreams.handler({ db: { query } } as any, {
        serviceKey: "service-key",
        cursor: null,
        numItems: 25,
      }),
    ).resolves.toEqual({
      rowCount: 2,
      isDone: false,
      continueCursor: "next-cursor",
    });

    expect(mockValidateServiceKey).toHaveBeenCalledWith("service-key");
    expect(query).toHaveBeenCalledWith("temp_streams");
    expect(paginate).toHaveBeenCalledWith({ cursor: null, numItems: 25 });
  });

  it("purges only one bounded batch and reports remaining rows", async () => {
    const rows = [{ _id: "temp-1" }, { _id: "temp-2" }, { _id: "temp-3" }];
    const take = jest.fn().mockResolvedValue(rows);
    const order = jest.fn(() => ({ take }));
    const query = jest.fn(() => ({ order }));
    const deleteRow = jest.fn().mockResolvedValue(undefined);
    const { purgeLegacyTempStreams } = await import("../tempStreams");

    await expect(
      purgeLegacyTempStreams.handler(
        { db: { query, delete: deleteRow } } as any,
        { serviceKey: "service-key", limit: 2 },
      ),
    ).resolves.toEqual({ deletedCount: 2, hasMore: true });

    expect(mockValidateServiceKey).toHaveBeenCalledWith("service-key");
    expect(take).toHaveBeenCalledWith(3);
    expect(deleteRow.mock.calls).toEqual([["temp-1"], ["temp-2"]]);
  });
});
