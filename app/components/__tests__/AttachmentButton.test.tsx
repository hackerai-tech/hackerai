import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttachmentButton } from "../AttachmentButton";
import { TooltipProvider } from "@/components/ui/tooltip";

let mockSubscription = "pro";
const mockCapture = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: false,
  }),
}));
jest.mock("@/lib/analytics/client", () => ({
  captureAuthenticatedEvent: (...args: unknown[]) => mockCapture(...args),
  captureUpgradeCtaImpression: jest.fn(),
}));
jest.mock("@/app/hooks/usePricingDialog", () => ({
  redirectToPricing: jest.fn(),
}));

beforeEach(() => {
  mockSubscription = "pro";
  jest.clearAllMocks();
});

it.each([
  ["Camera", "camera"],
  ["Photos & files", "files"],
])("opens %s and records goal exposure only once", async (label, source) => {
  const onAttachClick = jest.fn();
  const goalMenu = {
    active: false,
    onSelect: jest.fn(),
    onFocusComposer: jest.fn(),
  };
  render(
    <AttachmentButton onAttachClick={onAttachClick} goalMenu={goalMenu} />,
  );
  expect(mockCapture).not.toHaveBeenCalled();
  const add = screen.getByRole("button", {
    name: "Add files or pursue a goal",
  });
  fireEvent.keyDown(add, { key: "Enter" });
  fireEvent.click(await screen.findByRole("menuitem", { name: label }));
  expect(onAttachClick).toHaveBeenCalledWith(source);
  expect(goalMenu.onSelect).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  fireEvent.keyDown(add, { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Pursue goal" });
  expect(mockCapture.mock.calls).toEqual([
    ["agent_goal_exposed", { surface: "composer_plus_menu" }],
  ]);
});

it.each([false, true])(
  "selects or refocuses a goal without duplicate intent (active=%s)",
  async (active) => {
    const goalMenu = {
      active,
      onSelect: jest.fn(),
      onFocusComposer: jest.fn(),
    };
    render(<AttachmentButton onAttachClick={jest.fn()} goalMenu={goalMenu} />);
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Add files or pursue a goal" }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /^Pursue goal/ }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(goalMenu.onFocusComposer).toHaveBeenCalled();
    expect(goalMenu.onSelect).toHaveBeenCalledTimes(active ? 0 : 1);
    expect(
      mockCapture.mock.calls.filter(
        ([event]) => event === "agent_goal_selected",
      ),
    ).toEqual(
      active
        ? []
        : [["agent_goal_selected", { surface: "composer_plus_menu" }]],
    );
  },
);

it("preserves the direct paid attachment action and Free upsell", async () => {
  const onAttachClick = jest.fn();
  const { rerender } = render(
    <TooltipProvider>
      <AttachmentButton onAttachClick={onAttachClick} />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  expect(onAttachClick).toHaveBeenCalledTimes(1);
  mockSubscription = "free";
  rerender(
    <TooltipProvider>
      <AttachmentButton
        onAttachClick={onAttachClick}
        goalMenu={{
          active: false,
          onSelect: jest.fn(),
          onFocusComposer: jest.fn(),
        }}
      />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  expect(
    await screen.findByRole("button", { name: "Upgrade now" }),
  ).toBeVisible();
  expect(onAttachClick).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("menuitem", { name: "Pursue goal" }),
  ).not.toBeInTheDocument();
});
