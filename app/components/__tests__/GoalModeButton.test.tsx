import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { GoalModeButton } from "../ChatInput/GoalModeButton";
import { TooltipProvider } from "@/components/ui/tooltip";

jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

test("the goal label keeps the mode on; only the explicit close button exits", () => {
  const onClear = jest.fn();
  render(
    <TooltipProvider>
      <GoalModeButton compact onClear={onClear} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByText("Goal", { exact: true }));
  expect(onClear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Exit goal mode" }));
  expect(onClear).toHaveBeenCalledTimes(1);
});
