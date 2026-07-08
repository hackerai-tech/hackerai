import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AdjustSpendingLimitDialog } from "../AdjustSpendingLimitDialog";

describe("AdjustSpendingLimitDialog", () => {
  it("shows an existing zero-dollar limit but prevents saving it again", () => {
    const onSave = jest.fn(async () => {});

    render(
      <AdjustSpendingLimitDialog
        open={true}
        onOpenChange={jest.fn()}
        onSave={onSave}
        isLoading={false}
        currentLimitDollars={0}
      />,
    );

    expect(screen.getByLabelText("Monthly spending limit")).toHaveValue("$0");
    expect(
      screen.getByRole("button", { name: "Set spending limit" }),
    ).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("clears the cap by saving null when set to unlimited", async () => {
    const onSave = jest.fn(async () => {});

    render(
      <AdjustSpendingLimitDialog
        open={true}
        onOpenChange={jest.fn()}
        onSave={onSave}
        isLoading={false}
        currentLimitDollars={0}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Set to unlimited" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(null));
  });
});
