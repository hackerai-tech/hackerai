import { describe, expect, it, jest } from "@jest/globals";
import { getPreferredFileStorageRegion } from "../file-storage-region";

describe("getPreferredFileStorageRegion", () => {
  it("returns a supported region from the geo endpoint", async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({ region: "eu-central-1" }),
    } as Response);
    global.fetch = fetchMock;

    await expect(getPreferredFileStorageRegion()).resolves.toBe("eu-central-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/file-storage/region", {
      cache: "no-store",
    });
    delete (global as { fetch?: typeof fetch }).fetch;
  });

  it("falls back safely for invalid or unavailable responses", async () => {
    const fetchMock = jest.fn<typeof fetch>();
    global.fetch = fetchMock;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ region: "ap-southeast-1" }),
    } as Response);
    await expect(getPreferredFileStorageRegion()).resolves.toBeUndefined();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(getPreferredFileStorageRegion()).resolves.toBeUndefined();
    delete (global as { fetch?: typeof fetch }).fetch;
  });
});
