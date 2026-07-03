import { render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useHasAuthenticatedBefore } from "../useHasAuthenticatedBefore";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";

jest.mock("@/lib/utils/client-storage", () => ({
  hasAuthenticatedBefore: jest.fn(),
}));

const mockHasAuthenticatedBefore =
  hasAuthenticatedBefore as jest.MockedFunction<typeof hasAuthenticatedBefore>;

function AuthHintProbe() {
  return (
    <div data-testid="auth-hint">
      {useHasAuthenticatedBefore() ? "yes" : "no"}
    </div>
  );
}

describe("useHasAuthenticatedBefore", () => {
  beforeEach(() => {
    mockHasAuthenticatedBefore.mockReset();
  });

  it("does not use the browser-only auth hint during server render", () => {
    mockHasAuthenticatedBefore.mockReturnValue(true);

    expect(renderToString(<AuthHintProbe />)).toContain(">no<");
    expect(mockHasAuthenticatedBefore).not.toHaveBeenCalled();
  });

  it("corrects to the browser auth hint after hydrating server-rendered markup", async () => {
    mockHasAuthenticatedBefore.mockReturnValue(true);

    const container = document.createElement("div");
    container.innerHTML = renderToString(<AuthHintProbe />);
    document.body.appendChild(container);
    const root = hydrateRoot(container, <AuthHintProbe />);

    try {
      await waitFor(() => {
        expect(screen.getByTestId("auth-hint")).toHaveTextContent("yes");
      });
      expect(mockHasAuthenticatedBefore).toHaveBeenCalled();
    } finally {
      root.unmount();
      container.remove();
    }
  });
});
