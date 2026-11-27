import "@testing-library/jest-dom";
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import AuthErrorPage from "../page";

async function renderWithCode(code: string | string[] | undefined) {
  render(
    await AuthErrorPage({
      searchParams: Promise.resolve({ code } as { code?: string }),
    }),
  );
}

describe("AuthErrorPage", () => {
  it("shows the HTTP status the callback redirects with", async () => {
    await renderWithCode("400");

    expect(screen.getByText("Error code: 400")).toBeInTheDocument();
  });

  it("does not echo third-party text from the link", async () => {
    await renderWithCode("Account locked. Call +1 555 0100 to restore access");

    expect(screen.getByText("Authentication Error")).toBeInTheDocument();
    expect(screen.queryByText(/Error code/)).not.toBeInTheDocument();
    expect(screen.queryByText(/555 0100/)).not.toBeInTheDocument();
  });

  it("ignores a repeated code parameter", async () => {
    await renderWithCode(["503", "Call support"]);

    expect(screen.queryByText(/Error code/)).not.toBeInTheDocument();
  });
});
