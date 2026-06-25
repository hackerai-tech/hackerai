import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { GlobalStateProvider, useGlobalState } from "../GlobalState";

const mockAuthUser = (entitlements: string[]) => {
  jest.mocked(useAuth).mockReturnValue({
    user: { id: "user_ultra" },
    entitlements,
    loading: false,
    isAuthenticated: true,
    signIn: jest.fn(),
    signOut: jest.fn(),
  } as ReturnType<typeof useAuth>);
};

function GlobalStateProbe() {
  const { chatMode, sandboxPreference, selectedModel } = useGlobalState();

  return (
    <>
      <div data-testid="chat-mode">{chatMode}</div>
      <div data-testid="sandbox-preference">{sandboxPreference}</div>
      <div data-testid="selected-model">{selectedModel}</div>
    </>
  );
}

describe("GlobalStateProvider agent defaults", () => {
  beforeEach(() => {
    window.localStorage.clear();
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false }),
    ) as unknown as typeof fetch;
    mockAuthUser([]);
  });

  it("defaults first-time Ultra users to Agent with the auto model and cloud sandbox", async () => {
    window.localStorage.setItem("selected_model", "hackerai-max");
    mockAuthUser(["ultra-plan"]);

    render(
      <GlobalStateProvider>
        <GlobalStateProbe />
      </GlobalStateProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("chat-mode")).toHaveTextContent("agent");
    });

    expect(screen.getByTestId("selected-model")).toHaveTextContent("auto");
    expect(screen.getByTestId("sandbox-preference")).toHaveTextContent("e2b");
  });
});
