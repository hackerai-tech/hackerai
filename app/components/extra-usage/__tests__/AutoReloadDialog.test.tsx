import "@testing-library/jest-dom";
import { describe, expect, it, jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { AutoReloadDialog } from "../AutoReloadDialog";

describe("AutoReloadDialog", () => {
  it("explains that oversized requests can charge beyond the reload target", () => {
    render(
      <AutoReloadDialog
        open={true}
        onOpenChange={jest.fn()}
        onSave={jest.fn(async () => {})}
        onTurnOff={jest.fn(async () => {})}
        onCancel={jest.fn()}
        isLoading={false}
        isEnabled={false}
        currentThresholdDollars={5}
        currentAmountDollars={15}
      />,
    );

    expect(
      screen.getByText(/Auto-reload usually tops your balance up/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/if a request costs more, it may charge enough/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Set a monthly spending limit to cap auto-reload charges/i,
      ),
    ).toBeInTheDocument();
  });
});
