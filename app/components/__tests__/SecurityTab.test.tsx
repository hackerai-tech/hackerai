import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { CSSProperties, ReactNode } from "react";

const mockGetAccessToken = jest.fn<() => Promise<string | undefined>>();
let mockWidgetAuthToken: (() => Promise<string>) | undefined;

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAccessToken: () => ({ getAccessToken: mockGetAccessToken }),
}));

jest.mock("@workos-inc/widgets/workos-widgets", () => ({
  WorkOsWidgets: ({
    children,
    style,
  }: {
    children: ReactNode;
    style?: CSSProperties;
  }) => (
    <div data-testid="workos-widgets-provider" style={style}>
      {children}
    </div>
  ),
}));

jest.mock("@workos-inc/widgets/user-security", () => ({
  UserSecurity: ({ authToken }: { authToken: () => Promise<string> }) => {
    mockWidgetAuthToken = authToken;
    return <div data-testid="workos-user-security-widget" />;
  },
}));

describe("SecurityTab", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWidgetAuthToken = undefined;
    mockGetAccessToken.mockResolvedValue("access-token");
  });

  it("renders WorkOS User Security with a current access-token provider", async () => {
    const { SecurityTab } = await import("../SecurityTab");
    render(<SecurityTab />);

    expect(screen.getByTestId("workos-widgets-provider")).toBeInTheDocument();
    expect(screen.getByTestId("workos-widgets-provider")).toHaveStyle(
      "block-size: auto; min-block-size: auto",
    );
    expect(
      screen.getByTestId("workos-user-security-widget"),
    ).toBeInTheDocument();
    expect(mockWidgetAuthToken).toBeDefined();
    await expect(mockWidgetAuthToken?.()).resolves.toBe("access-token");
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
  });

  it("rejects widget requests when the session has no access token", async () => {
    mockGetAccessToken.mockResolvedValue(undefined);
    const { SecurityTab } = await import("../SecurityTab");
    render(<SecurityTab />);

    expect(mockWidgetAuthToken).toBeDefined();
    await expect(mockWidgetAuthToken?.()).rejects.toThrow(
      "Unable to load security settings",
    );
  });

  it("keeps both session logout actions in a shared card", async () => {
    const { SecurityTab } = await import("../SecurityTab");
    render(<SecurityTab />);

    expect(screen.getByTestId("security-session-actions")).toHaveClass(
      "rounded-lg",
      "border",
    );
    expect(screen.getByText("Log out of this device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.getByText("Log out of all devices")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Log out of all active sessions across all devices, including your current session/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Log out all" }),
    ).toBeInTheDocument();
  });
});
