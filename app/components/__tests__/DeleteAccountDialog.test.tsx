import "@testing-library/jest-dom";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import DeleteAccountDialog from "../DeleteAccountDialog";

jest.mock("@workos-inc/authkit-nextjs/components", () => ({
  useAuth: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: {
    error: jest.fn(),
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;
jest.spyOn(console, "error").mockImplementation(() => {});

describe("DeleteAccountDialog", () => {
  const mockUser = {
    email: "signin.hackerai.co.harmonize442@passmail.net",
    lastSignInAt: new Date().toISOString(),
  };
  const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;

  const renderDialog = () =>
    render(<DeleteAccountDialog open={true} onOpenChange={jest.fn()} />);

  const renderControlledDialog = (open: boolean) =>
    render(<DeleteAccountDialog open={open} onOpenChange={jest.fn()} />);

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockUseAuth.mockReturnValue({
      user: {
        ...mockUser,
        lastSignInAt: new Date().toISOString(),
      },
    } as ReturnType<typeof useAuth>);
  });

  const confirmDeletion = () => {
    fireEvent.change(screen.getByTestId("delete-phrase-input"), {
      target: { value: "DELETE" },
    });
    fireEvent.change(screen.getByTestId("email-confirmation"), {
      target: { value: mockUser.email },
    });
    fireEvent.click(screen.getByTestId("delete-button"));
  };

  it("keeps the delete button visible but disabled before confirmation", () => {
    renderDialog();

    expect(screen.getByTestId("delete-button")).toBeDisabled();
    expect(screen.getByTestId("delete-account-description")).toHaveClass(
      "pt-2",
    );
    expect(screen.getByTestId("delete-account-footer")).toHaveClass("pt-4");
  });

  it("shows the email in the input placeholder without filling it", () => {
    renderDialog();

    const emailInput = screen.getByTestId(
      "email-confirmation",
    ) as HTMLInputElement;

    expect(emailInput.value).toBe("");
    expect(emailInput.placeholder).toBe(mockUser.email);
  });

  it("enables account deletion only after email and phrase both match", () => {
    renderDialog();

    const deleteButton = screen.getByTestId("delete-button");
    fireEvent.change(screen.getByTestId("delete-phrase-input"), {
      target: { value: "DELETE" },
    });

    expect(deleteButton).toBeDisabled();

    fireEvent.change(screen.getByTestId("email-confirmation"), {
      target: { value: mockUser.email },
    });

    expect(deleteButton).toBeEnabled();
  });

  it("shows a refresh login action when the login is stale", () => {
    mockUseAuth.mockReturnValue({
      user: {
        ...mockUser,
        lastSignInAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      },
    } as ReturnType<typeof useAuth>);

    renderDialog();

    expect(screen.getByTestId("refresh-login-button")).toHaveTextContent(
      "Refresh login",
    );
    expect(screen.queryByTestId("delete-button")).not.toBeInTheDocument();
  });

  it("resets confirmations after the dialog closes", () => {
    const { rerender } = renderControlledDialog(true);

    fireEvent.change(screen.getByTestId("delete-phrase-input"), {
      target: { value: "DELETE" },
    });
    fireEvent.change(screen.getByTestId("email-confirmation"), {
      target: { value: mockUser.email },
    });

    expect(screen.getByTestId("delete-button")).toBeEnabled();

    rerender(<DeleteAccountDialog open={false} onOpenChange={jest.fn()} />);
    rerender(<DeleteAccountDialog open={true} onOpenChange={jest.fn()} />);

    expect(screen.getByTestId("delete-button")).toBeDisabled();
    expect(
      (screen.getByTestId("email-confirmation") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("delete-phrase-input") as HTMLInputElement).value,
    ).toBe("");
  });

  it("continues account cleanup across bounded server requests", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: "account_cleanup_in_progress" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: "account_cleanup_in_progress" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: "terminal cleanup failure" }),
      });

    renderDialog();
    confirmDeletion();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockFetch).toHaveBeenNthCalledWith(1, "/api/delete-account", {
      method: "POST",
    });
    expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/delete-account", {
      method: "POST",
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, "/api/delete-account", {
      method: "POST",
    });
    await waitFor(() =>
      expect(screen.getByTestId("delete-button")).toBeEnabled(),
    );
  });

  it("finishes external cleanup only after the continuation completes", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: "account_cleanup_in_progress" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

    renderDialog();
    confirmDeletion();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    expect(mockFetch).toHaveBeenNthCalledWith(1, "/api/delete-account", {
      method: "POST",
    });
    expect(mockFetch).toHaveBeenNthCalledWith(2, "/api/delete-account", {
      method: "POST",
    });
    expect(mockFetch).toHaveBeenNthCalledWith(3, "/api/clear-auth-cookies", {
      method: "POST",
    });
  });

  it("stops cleanup continuation after the client request bound", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: "account_cleanup_in_progress" }),
    });

    renderDialog();
    confirmDeletion();

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(10));
    await waitFor(() =>
      expect(screen.getByTestId("delete-button")).toBeEnabled(),
    );
  });
});
