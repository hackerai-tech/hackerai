import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockNavigateToAuth = jest.fn();

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ loading: false, user: null }),
}));

jest.mock("@/app/hooks/useTauri", () => ({
  navigateToAuth: mockNavigateToAuth,
}));

const Header = require("../Header")
  .default as typeof import("../Header").default;

describe("Header", () => {
  beforeEach(() => {
    mockNavigateToAuth.mockClear();
  });

  it("provides public navigation and auth actions in the mobile menu", async () => {
    const user = userEvent.setup();
    render(<Header />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const dialog = await screen.findByRole("dialog");
    const navigation = within(dialog).getByRole("navigation", {
      name: "Mobile",
    });

    for (const [name, href] of [
      ["Product", "/product"],
      ["Pricing", "/pricing"],
      ["Download", "/download"],
      ["Trust", "/trust"],
    ]) {
      expect(within(navigation).getByRole("link", { name })).toHaveAttribute(
        "href",
        href,
      );
    }

    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    expect(mockNavigateToAuth).toHaveBeenCalledWith("/login");

    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: /get started/i,
      }),
    );
    expect(mockNavigateToAuth).toHaveBeenCalledWith("/signup", {
      preferSignInForReturningUser: true,
    });
  });

  it("omits the current download destination when requested", async () => {
    const user = userEvent.setup();
    render(<Header hideDownload />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const navigation = within(await screen.findByRole("dialog")).getByRole(
      "navigation",
      { name: "Mobile" },
    );
    expect(
      within(navigation).queryByRole("link", { name: "Download" }),
    ).not.toBeInTheDocument();
  });
});
