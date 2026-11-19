import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharedChatView } from "../SharedChatView";

const mockClient = {
  query: jest
    .fn()
    .mockResolvedValue({
      chat: { id: "task", title: "Shared task", share_date: 1 },
      messages: [],
    }),
};
jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  useMutation: () => jest.fn(),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: () => ({ user: { id: "qa" }, loading: false }),
}));
jest.mock("@/app/contexts/GlobalState", () => ({
  useGlobalState: () => {
    const [chatSidebarOpen, setChatSidebarOpen] =
      require("react").useState(false);
    return { chatSidebarOpen, setChatSidebarOpen };
  },
}));
jest.mock("@/app/contexts/ComposerState", () => ({
  useComposerInput: () => "",
}));
jest.mock("@/app/hooks/useStartNewChat", () => ({
  useStartNewChat: () => jest.fn(),
}));
jest.mock("@/app/components/MessageSearchDialog", () => ({
  MessageSearchDialog: () => null,
}));
jest.mock("@/app/components/ComputerSidebar", () => ({
  ComputerSidebarBase: () => null,
}));
jest.mock("@/app/components/Header", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/app/components/ChatHeader", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/app/components/ChatInput", () => ({ ChatInput: () => null }));
jest.mock("../SharedMessages", () => ({
  SharedMessages: () => <p>Shared conversation</p>,
}));
jest.mock("@/app/components/Sidebar", () => ({
  __esModule: true,
  default: ({ onClose }: { onClose: () => void }) => (
    <>
      <button
        onClick={() =>
          require("@/lib/keyboard-shortcuts").openKeyboardShortcuts()
        }
      >
        Keyboard shortcuts
      </button>
      <button onClick={onClose}>Close sidebar</button>
    </>
  ),
}));

it("focuses and contains shared mobile navigation, dismisses Help first, and restores the opener", async () => {
  const user = userEvent.setup();
  render(
    <>
      <button>Opener</button>
      <SharedChatView shareId="12345678-1234-1234-1234-123456789012" />
    </>,
  );
  await screen.findByText("Shared conversation");
  const opener = screen.getByRole("button", { name: "Opener" });
  opener.focus();
  fireEvent.keyDown(opener, { key: "S", ctrlKey: true, shiftKey: true });
  const sidebar = screen.getByRole("dialog", { name: "Task sidebar" });
  const help = screen.getByRole("button", { name: "Keyboard shortcuts" });
  await waitFor(() => expect(help).toHaveFocus());
  await user.tab({ shift: true });
  expect(sidebar).toContainElement(document.activeElement as HTMLElement);
  await user.tab();
  expect(help).toHaveFocus();
  await user.click(help);
  expect(
    screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
  ).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
    ).not.toBeInTheDocument(),
  );
  expect(sidebar).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Task sidebar" }),
    ).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(opener).toHaveFocus());
});
