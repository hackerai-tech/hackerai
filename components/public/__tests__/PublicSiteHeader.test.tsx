import { describe, expect, it } from "@jest/globals";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PublicSiteHeader } from "../PublicSiteHeader";

describe("PublicSiteHeader", () => {
  it("provides public navigation and auth actions in the mobile menu", async () => {
    const user = userEvent.setup();
    render(<PublicSiteHeader />);

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
      within(dialog).getByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/login");
    expect(
      within(dialog).getByRole("link", { name: /get started/i }),
    ).toHaveAttribute("href", "/signup");
  });
});
