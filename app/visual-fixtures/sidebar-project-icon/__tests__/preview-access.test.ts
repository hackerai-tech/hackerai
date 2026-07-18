import { describe, expect, it } from "@jest/globals";
import { canViewSidebarProjectIconPreview } from "../preview-access";

describe("canViewSidebarProjectIconPreview", () => {
  it("allows local development and Vercel previews", () => {
    expect(canViewSidebarProjectIconPreview({ NODE_ENV: "development" })).toBe(
      true,
    );
    expect(
      canViewSidebarProjectIconPreview({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(true);
  });

  it("stays unavailable in production and unknown environments", () => {
    expect(
      canViewSidebarProjectIconPreview({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }),
    ).toBe(false);
    expect(canViewSidebarProjectIconPreview({})).toBe(false);
  });
});
