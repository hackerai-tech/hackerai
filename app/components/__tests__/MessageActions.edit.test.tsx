import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/components/ui/with-tooltip", () => ({
  WithTooltip: ({ trigger }: { trigger: React.ReactNode }) => trigger,
}));

const { MessageActions } =
  require("../MessageActions") as typeof import("../MessageActions");

const renderUserActions = (canEdit: boolean, onEdit = jest.fn()) => {
  render(
    <MessageActions
      messageText="Question"
      isUser
      isLastAssistantMessage={false}
      canRegenerate={false}
      onRegenerate={jest.fn()}
      onEdit={onEdit}
      canEdit={canEdit}
      isHovered
      isEditing={false}
      status="ready"
    />,
  );

  return onEdit;
};

describe("MessageActions editing", () => {
  it("does not offer editing for an older user message", () => {
    renderUserActions(false);

    expect(
      screen.queryByRole("button", { name: "Edit message" }),
    ).not.toBeInTheDocument();
  });

  it("offers editing for the latest user message", () => {
    const onEdit = renderUserActions(true);

    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
