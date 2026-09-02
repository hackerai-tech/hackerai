import { describe, expect, it } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PublicSiteHeader } from "../PublicSiteHeader";

describe("PublicSiteHeader", () => {
  it("keeps auth actions in the header and navigation in the mobile menu", async () => {
    const user = userEvent.setup();
    render(<PublicSiteHeader currentPath="/pricing" />);

    const signInLinks = screen.getAllByRole("link", { name: "Sign in" });
    const signUpLinks = screen.getAllByRole("link", { name: /get started/i });
    expect(signInLinks).toHaveLength(2);
    expect(signUpLinks).toHaveLength(2);
    for (const link of signInLinks)
      expect(link).toHaveAttribute("href", "/login");
    for (const link of signUpLinks)
      expect(link).toHaveAttribute("href", "/signup");

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

    expect(
      within(navigation).getByRole("link", { name: "Pricing" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(dialog).queryByRole("link", { name: "Sign in" }),
    ).not.toBeInTheDocument();
  });
});
