import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalAutoContinueNotice } from "../LocalAutoContinueNotice";

describe("LocalAutoContinueNotice", () => {
  it("tells the user when Stop was not stored and lets them press it again", async () => {
    const user = userEvent.setup();
    const onStop = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("not stored"))
      .mockResolvedValueOnce(undefined);
    render(<LocalAutoContinueNotice onStop={onStop} />);

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't stop it. Try again.",
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
