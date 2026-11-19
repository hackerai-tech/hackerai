import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { WaitingForReplyBanner } from "../WaitingForReplyBanner";

const baseProps = {
  submitting: false,
  stopping: false,
  hasAttachments: false,
  hideStop: false,
  onStop: jest.fn(),
};

describe("WaitingForReplyBanner", () => {
  it("explains why an existing attachment blocks the reply", () => {
    render(<WaitingForReplyBanner {...baseProps} hasAttachments />);

    expect(screen.getByText(/Remove attachments to reply/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Stop agent instead/ }),
    ).toBeEnabled();
  });

  it("prevents repeated stop requests while cancellation is pending", () => {
    render(<WaitingForReplyBanner {...baseProps} stopping />);

    expect(
      screen.getByRole("button", { name: /Stop agent instead/ }),
    ).toBeDisabled();
    expect(screen.getByText("Stopping…")).toBeInTheDocument();
  });
});
