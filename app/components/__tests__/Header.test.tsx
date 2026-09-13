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

  it("keeps auth actions in the header and navigation in the mobile menu", async () => {
    const user = userEvent.setup();
    render(<Header />);

    await user.click(screen.getByTestId("sign-in-button-mobile"));
    expect(mockNavigateToAuth).toHaveBeenCalledWith("/login");
    await user.click(screen.getByTestId("sign-up-button-mobile"));
    expect(mockNavigateToAuth).toHaveBeenCalledWith("/signup", {
      preferSignInForReturningUser: true,
    });

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

    // The header stays in place; the same button now closes the menu.
    expect(screen.getByTestId("sign-in-button-mobile")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps every page in the menu and marks the current one", async () => {
    const user = userEvent.setup();
    render(<Header currentPath="/download" />);

    await user.click(screen.getByRole("button", { name: "Open navigation" }));

    const navigation = within(await screen.findByRole("dialog")).getByRole(
      "navigation",
      { name: "Mobile" },
    );
    const download = within(navigation).getByRole("link", {
      name: "Download",
    });
    expect(download).toHaveAttribute("aria-current", "page");
    expect(
      within(navigation).getByRole("link", { name: "Trust" }),
    ).not.toHaveAttribute("aria-current");
  });
});
