import { buildWorkOSOrganizationName } from "../workos-organization-name";

describe("buildWorkOSOrganizationName", () => {
  it("uses the user's display name when available", () => {
    expect(
      buildWorkOSOrganizationName({
        email: "billing@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    ).toBe("Ada Lovelace");
  });

  it("falls back to a sanitized email local part", () => {
    expect(
      buildWorkOSOrganizationName({
        email: "john+billing@example.com",
      }),
    ).toBe("john billing");
  });

  it("keeps characters allowed by WorkOS organization names", () => {
    expect(
      buildWorkOSOrganizationName({
        firstName: "O'Connor-Smith",
        lastName: "& Co. (NY), Inc.",
      }),
    ).toBe("O'Connor-Smith & Co. (NY), Inc.");
  });

  it("falls back when there is no valid organization name content", () => {
    expect(
      buildWorkOSOrganizationName({
        email: "...+++@example.com",
      }),
    ).toBe("Personal Workspace");
  });
});
