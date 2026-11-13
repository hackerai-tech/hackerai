import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AttachmentButton } from "../AttachmentButton";
import { TooltipProvider } from "@/components/ui/tooltip";

let mockSubscription = "pro";
let mockPlanChecking = false;
const mockCapture = jest.fn();
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => ({
    subscription: mockSubscription,
    isCheckingProPlan: mockPlanChecking,
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
  mockPlanChecking = false;
  jest.clearAllMocks();
});

it.each([
  ["Camera", "camera"],
  ["Photos & files", "files"],
])("opens %s and records goal exposure only once", async (label, source) => {
  const onAttachClick = jest.fn();
  const goalMenu = {
    active: false,
    layout: "mobile" as const,
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
  const context = {
    surface: "composer_plus_menu",
    composer_layout: "mobile",
    goal_ui_version: 2,
    goal_mode_active: false,
    has_draft: false,
    has_attachments: false,
  };
  expect(
    mockCapture.mock.calls.filter(([event]) => event === "agent_goal_exposed"),
  ).toEqual([["agent_goal_exposed", context]]);
  expect(
    mockCapture.mock.calls.filter(
      ([event]) => event === "composer_plus_menu_action",
    ),
  ).toEqual([
    ["composer_plus_menu_action", { ...context, action: "opened" }],
    ["composer_plus_menu_action", { ...context, action: source }],
    ["composer_plus_menu_action", { ...context, action: "opened" }],
  ]);
});

it.each([false, true])(
  "selects or refocuses a goal without duplicate intent (active=%s)",
  async (active) => {
    const goalMenu = {
      active,
      layout: "mobile" as const,
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
        : [
            [
              "agent_goal_selected",
              {
                surface: "composer_plus_menu",
                composer_layout: "mobile",
                goal_ui_version: 2,
                goal_mode_active: false,
                has_draft: false,
                has_attachments: false,
              },
            ],
          ],
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
          layout: "mobile" as const,
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

it("offers compact desktop file and goal actions without a camera", async () => {
  const onAttachClick = jest.fn();
  const goalMenu = {
    active: false,
    layout: "desktop" as const,
    onSelect: jest.fn(),
    onFocusComposer: jest.fn(),
  };
  render(
    <AttachmentButton onAttachClick={onAttachClick} goalMenu={goalMenu} />,
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add files or pursue a goal" }),
    { key: "Enter" },
  );
  await screen.findByRole("menuitem", { name: "Add photos & files" });
  expect(
    screen.queryByRole("menuitem", { name: "Camera" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: /Pursue goal/ }),
  ).toHaveTextContent("/goal");
  fireEvent.click(screen.getByRole("menuitem", { name: "Add photos & files" }));
  expect(onAttachClick).toHaveBeenCalledWith("files");
  expect(goalMenu.onSelect).not.toHaveBeenCalled();
});

it("records dismissing an active goal menu without selecting or clearing goal mode", async () => {
  const goalMenu = {
    active: true,
    layout: "desktop" as const,
    onSelect: jest.fn(),
    onFocusComposer: jest.fn(),
  };
  render(<AttachmentButton onAttachClick={jest.fn()} goalMenu={goalMenu} />);
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add files or pursue a goal" }),
    { key: "Enter" },
  );
  const menu = await screen.findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(goalMenu.onSelect).not.toHaveBeenCalled();
  expect(
    mockCapture.mock.calls
      .filter(([event]) => event === "composer_plus_menu_action")
      .map(([, props]) => props.action),
  ).toEqual(["opened", "dismissed"]);
  expect(
    mockCapture.mock.calls.some(([event]) => event === "agent_goal_selected"),
  ).toBe(false);
});

it.each(["desktop", "mobile"] as const)(
  "keeps Skills accessible without goal mode on %s without recording goal exposure",
  async (layout) => {
    const onSelect = jest.fn();
    render(
      <AttachmentButton
        onAttachClick={jest.fn()}
        skillsMenu={{ layout, disabled: false, onSelect }}
      />,
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "Add files or skills" }),
      { key: "Enter" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Skills", exact: true }),
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("menuitem", { name: /Pursue goal/ }),
    ).not.toBeInTheDocument();
    expect(
      mockCapture.mock.calls.filter(
        ([event]) => event === "agent_goal_exposed",
      ),
    ).toEqual([]);
  },
);

it("retains the attachment upgrade gate when a free account has Skills access", async () => {
  mockSubscription = "free";
  const onAttachClick = jest.fn();
  render(
    <AttachmentButton
      onAttachClick={onAttachClick}
      skillsMenu={{ layout: "desktop", disabled: false, onSelect: jest.fn() }}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add files or skills" }),
    { key: "Enter" },
  );
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Add photos & files" }),
  );
  expect(await screen.findByTestId("file-attach-upgrade-dialog")).toBeVisible();
  expect(onAttachClick).not.toHaveBeenCalled();
});

it("disables attachment actions during plan hydration while keeping Skills usable", async () => {
  mockSubscription = "free";
  mockPlanChecking = true;
  const onAttachClick = jest.fn();
  const onSelect = jest.fn();
  render(
    <AttachmentButton
      onAttachClick={onAttachClick}
      skillsMenu={{ layout: "mobile", disabled: false, onSelect }}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Add files or skills" }),
    { key: "Enter" },
  );
  const files = await screen.findByRole("menuitem", { name: "Photos & files" });
  const camera = screen.getByRole("menuitem", { name: "Camera" });
  expect(files).toHaveAttribute("aria-disabled", "true");
  expect(camera).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(files);
  fireEvent.click(camera);
  expect(onAttachClick).not.toHaveBeenCalled();
  expect(
    screen.queryByTestId("file-attach-upgrade-dialog"),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Skills", exact: true }),
  );
  await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
});
